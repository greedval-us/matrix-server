import { randomUUID } from 'node:crypto'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../core/errors.mjs'
import { OperationalRepository } from '../infrastructure/mysql/repository.mjs'
import { SEARCH_FIELDS } from '../modules/search/normalization.mjs'
import { CATALOG_FIELDS } from '../modules/workspace/resources.mjs'
import { catalogValues } from './catalog.mjs'

const searchFields = new Set(SEARCH_FIELDS)
const catalogFlags = CATALOG_FIELDS.filter(key => key.startsWith('search_'))
const batchRows = 250
const batchBytes = 1024 * 1024
const maximumKeys = 16_384
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export class CatalogImportError extends ApplicationError {}
const invalid = message => new CatalogImportError(grpc.status.INVALID_ARGUMENT, message)
const exhausted = message => new CatalogImportError(grpc.status.RESOURCE_EXHAUSTED, message)

async function ingestFiles(source, table, files) {
  const keys = new Set()
  const searchable = new Set()
  let rows = 0
  let fileCount = 0
  let records = []
  let bytes = 0
  async function flush() {
    if (!records.length) return
    await source.execute(`INSERT INTO \`${table}\` (\`matrix_json\`) VALUES ${records.map(() => '(?)').join(', ')}`, records)
    records = []
    bytes = 0
  }

  for await (const file of files) {
    let hasSearchField = false
    for await (const raw of file.records) {
      let record
      try { record = JSON.parse(raw) } catch { throw invalid(`Некорректная запись JSON в файле «${file.name}».`) }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw invalid(`Записи в файле «${file.name}» должны быть объектами JSON.`)
      }
      for (const [key, value] of Object.entries(record)) {
        if (!key.trim() || !key.isWellFormed() || [...key].length > 64 || /\p{Cc}/u.test(key)) {
          throw invalid(`В файле «${file.name}» имя поля пустое, длиннее 64 символов или содержит недопустимые символы.`)
        }
        keys.add(key)
        if (keys.size > maximumKeys) throw exhausted(`В базе может быть до ${maximumKeys} различных имён полей.`)
        if (searchFields.has(key) && value !== null && typeof value !== 'object' && String(value).trim()) {
          hasSearchField = true
          searchable.add(key)
        }
      }
      const size = Buffer.byteLength(raw)
      if (records.length >= batchRows || bytes + size > batchBytes) await flush()
      records.push(raw)
      bytes += size
      rows++
      if (rows > 4_294_967_295) throw exhausted('Превышено число строк для одной базы.')
    }
    if (!hasSearchField) throw invalid(`В файле «${file.name}» нужно хотя бы одно заполненное поисковое поле, например number или mail.`)
    fileCount++
  }
  if (!fileCount) throw invalid('Выберите папку хотя бы с одним файлом JSON.')
  await flush()
  return { keys, searchable, rows, files: fileCount }
}

async function registerLabels(connection, keys) {
  // Consistent lock order for concurrent imports with overlapping keys.
  const ordered = [...keys].sort()
  let inserted = 0
  for (let start = 0; start < ordered.length; start += batchRows) {
    const batch = ordered.slice(start, start + batchRows)
    const [result] = await connection.execute(
      'INSERT IGNORE INTO `search_field_labels` (`field_key`, `label`) VALUES ' + batch.map(() => '(?, ?)').join(', '),
      batch.flatMap(key => [key, key]),
    )
    inserted += result.affectedRows
  }
  return inserted
}

async function registerDatabase(connection, values, tableName, catalogGuard) {
  async function insert(entries) {
    const [result] = await connection.execute(
      'INSERT INTO `data_base` (' + entries.map(([key]) => `\`${key}\``).join(', ') + ', `created_at`, `updated_at`) ' +
      'VALUES (' + entries.map(() => '?').join(', ') + ', UTC_TIMESTAMP(), UTC_TIMESTAMP())',
      entries.map(([, value]) => value),
    )
    return String(result.insertId)
  }
  const id = await insert(values)
  const checkId = candidate => catalogGuard({ operation: 'create', id: candidate, tableName, findAvailable: true })
  const suggested = await checkId(id)
  if (!suggested) return id

  // After restoring an older database, AUTO_INCREMENT can fall into the
  // published range. Keep the finished source and allocate above the live tail.
  await connection.rollback()
  await connection.beginTransaction()
  const [[last]] = await connection.execute('SELECT `id` FROM `data_base` ORDER BY `id` DESC LIMIT 1 FOR UPDATE')
  const candidate = Math.max(Number(suggested), Number(last?.id || 0) + 1)
  if (candidate > 4_294_967_295) throw exhausted('Закончились доступные идентификаторы баз.')
  const available = await checkId(String(candidate)) || String(candidate)
  await insert([...values, ['id', available]])
  return available
}

export function createCatalogImporter({ pool, sourcePool, catalogGuard }) {
  const repository = new OperationalRepository(pool)
  return async function importCatalog(metadata, files, importId = randomUUID()) {
    if (typeof importId !== 'string' || !uuidPattern.test(importId)) throw invalid('Недопустимый идентификатор импорта.')
    const entries = await catalogValues(metadata, repository, { create: true })
    if (!sourcePool) throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Источник для импорта не настроен.')
    const table = 'json_import_' + importId.replaceAll('-', '')
    try {
      await sourcePool.execute(`CREATE TABLE \`${table}\` (
        \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        \`matrix_json\` JSON NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4`)
    } catch (error) {
      if (error.code === 'ER_TABLE_EXISTS_ERROR') {
        throw new CatalogImportError(grpc.status.ALREADY_EXISTS, `Таблица этого импорта уже существует. Найдите ${table} в «Каталоге баз».`)
      }
      throw error
    }
    let commitStarted = false
    try {
      const { keys, searchable, rows, files: fileCount } = await ingestFiles(sourcePool, table, files)
      const connection = await pool.getConnection()
      let reusable = true
      try {
        await connection.beginTransaction()
        const values = [...entries, ['name_table', table], ['count', rows],
          ...catalogFlags.map(flag => [flag, Number(searchable.has(flag.slice(7)))])]
        const id = await registerDatabase(connection, values, table, catalogGuard)
        const newFields = await registerLabels(connection, keys)
        commitStarted = true
        await connection.commit()
        return { row: { id, name_table: table }, rows, files: fileCount, newFields }
      } catch (error) {
        // A lost COMMIT acknowledgement can refer to an already published table.
        if (commitStarted) reusable = false
        else try { await connection.rollback() } catch { reusable = false }
        throw error
      } finally {
        if (reusable) connection.release()
        else connection.destroy()
      }
    } catch (error) {
      if (commitStarted) {
        throw new CatalogImportError(grpc.status.UNAVAILABLE, `Нет подтверждения публикации. Проверьте ${table} в «Каталоге баз» перед повторным импортом.`)
      }
      try {
        await sourcePool.execute(`DROP TABLE \`${table}\``)
      } catch {
        throw new CatalogImportError(grpc.status.UNAVAILABLE, `База не опубликована. Проверьте незавершённую таблицу ${table} в источнике.`)
      }
      throw error
    }
  }
}
