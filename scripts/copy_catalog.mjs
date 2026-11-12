import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createMysqlPool } from '../node/infrastructure/mysql/pool.mjs'
import { normalizeCatalogTypeName } from '../node/infrastructure/mysql/catalog-types.mjs'
import { readMysqlSettings } from '../node/infrastructure/mysql/settings.mjs'
import { CATALOG_FIELDS } from '../node/modules/workspace/resources.mjs'

const columns = CATALOG_FIELDS.map(field => `\`${field}\``).join(', ')

async function importCatalogType(connection, value, types) {
  const name = normalizeCatalogTypeName(value)
  if (name === null) return value ?? null
  if (types.has(name)) return types.get(name)
  await connection.execute(
    'INSERT INTO `catalog_types` (`name`) VALUES (?) ON DUPLICATE KEY UPDATE `name` = `catalog_types`.`name`', [name],
  )
  const [[type]] = await connection.execute('SELECT `name`, `alias_for` FROM `catalog_types` WHERE `name` = ?', [name])
  const canonical = type.alias_for ?? type.name
  types.set(name, canonical)
  return canonical
}

export async function copyCatalog(sourcePool, targetPool) {
  const connection = await targetPool.getConnection()
  let locked = false
  let transaction = false
  try {
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', ['matrix:catalog-copy'])
    if (Number(lock.acquired) !== 1) throw new Error('Cannot acquire catalogue copy lock')
    locked = true
    await connection.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
    await connection.beginTransaction()
    transaction = true
    // Lock the complete primary-key range, including the empty-table gap, so
    // concurrent API inserts cannot bypass the empty-destination check.
    const [existing] = await connection.execute('SELECT `id` FROM `data_base` FOR UPDATE')
    if (existing.length) throw new Error('Catalogue destination must be empty')
    const [rows] = await sourcePool.execute(`SELECT ${columns} FROM \`data_base\` ORDER BY \`id\``)
    const types = new Map()
    for (const row of rows) {
      const id = String(row.id)
      if (!/^[1-9][0-9]{0,9}$/.test(id) || BigInt(id) > 4294967295n || !/^[A-Za-z0-9_]{1,64}$/.test(row.name_table)) throw new Error('Invalid source catalogue identity')
      const values = { ...row, type: await importCatalogType(connection, row.type, types) }
      await connection.execute(`INSERT INTO \`data_base\` (${columns}) VALUES (${CATALOG_FIELDS.map(() => '?').join(', ')})`, CATALOG_FIELDS.map(field => values[field] ?? null))
    }
    await connection.commit()
    transaction = false
    return rows.length
  } catch (error) {
    if (transaction) await connection.rollback()
    throw error
  } finally {
    try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', ['matrix:catalog-copy']) }
    finally { connection.release() }
  }
}

async function main() {
  const sourceSettings = readMysqlSettings(process.env, 'SOURCE_MYSQL')
  const targetSettings = readMysqlSettings()
  if (sourceSettings.host === targetSettings.host && sourceSettings.port === targetSettings.port && sourceSettings.database === targetSettings.database) throw new Error('Source and target must be separate databases')
  const sourcePool = createMysqlPool(sourceSettings)
  const targetPool = createMysqlPool(targetSettings)
  try { console.log(`Copied ${await copyCatalog(sourcePool, targetPool)} catalogue row(s)`) }
  finally { await Promise.allSettled([sourcePool.end(), targetPool.end()]) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Catalogue copy failed; check configuration, empty target and source catalogue validity'); process.exitCode = 1 })
}
