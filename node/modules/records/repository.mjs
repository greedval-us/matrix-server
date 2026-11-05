import { ApplicationError } from '../../core/errors.mjs'
import { CONTROL_COLUMNS, CONTROL_FIELDS, MAX_ROW_FILES, listOptions, readFiles, validateFileId, validateFiles, validateId, validateValues } from './fields.mjs'

const quote = key => `\`${key}\``
const selection = [...CONTROL_FIELDS, 'files'].map(quote).join(', ')
const missing = () => new ApplicationError(5, 'Control record or file was not found')

function databaseError(error) {
  if (error instanceof ApplicationError) return error
  if (error?.code === 'ER_DUP_ENTRY') return new ApplicationError(6, 'Control record already exists')
  return new ApplicationError(14, 'Operational database is unavailable')
}

function storedId(value, { insert = false } = {}) {
  try {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error()
    let id = String(value)
    // mysql2 OK packets may decode an unsigned insert ID as a signed integer.
    if (insert && /^-[1-9][0-9]*$/.test(id)) id = BigInt.asUintN(64, BigInt(id)).toString()
    return validateId(id)
  } catch { throw new ApplicationError(13, 'Invalid stored control record identity') }
}

function rowValue(row) {
  const id = storedId(row.id)
  return { id, values: Object.fromEntries(CONTROL_FIELDS.map(key => [key, key === 'id' ? id : row[key] == null ? '' : String(row[key])])), files: readFiles(row.files) }
}

function totalValue(value) {
  if ((typeof value === 'number' && !Number.isSafeInteger(value)) || !/^(0|[1-9][0-9]*)$/.test(String(value))) {
    throw new ApplicationError(13, 'Invalid stored control record count')
  }
  return String(value)
}

export class ControlRepository {
  constructor(pool) { this.pool = pool }

  async execute(sql, parameters = [], target = this.pool) {
    try { const [result] = await target.execute(sql, parameters); return result }
    catch (error) { throw databaseError(error) }
  }

  async transaction(operation) {
    let connection
    let started = false
    let commitAttempted = false
    let dirty = false
    try {
      connection = await this.pool.getConnection()
      await connection.beginTransaction()
      started = true
      const result = await operation(connection)
      commitAttempted = true
      await connection.commit()
      return result
    } catch (error) {
      let rolledBack = !started
      if (started) {
        try { await connection.rollback(); rolledBack = true }
        catch { dirty = true }
      }
      const safe = databaseError(error)
      const failure = new ApplicationError(safe.code, safe.message)
      // Only this transaction's evidence can authorize removal of staged bytes.
      // A successful ROLLBACK after a lost COMMIT response cannot undo a COMMIT
      // that MySQL already completed, so that outcome must remain uncertain.
      if (!commitAttempted && rolledBack) {
        Object.defineProperty(failure, 'metadataRolledBack', { value: true })
      }
      throw failure
    } finally {
      if (dirty) {
        // A pooled connection with an unresolved transaction must never be reused.
        try { connection?.destroy?.() } catch {}
      } else connection?.release()
    }
  }

  async list(request = {}) {
    const { query, key, direction, limit, offset } = listOptions(request)
    // An explicit escape character makes %, _ and = literal independently of
    // MySQL's NO_BACKSLASH_ESCAPES mode, while the value remains a bound parameter.
    const pattern = `%${query.replace(/[=%_]/g, value => `=${value}`)}%`
    const where = query ? ` WHERE (${CONTROL_FIELDS.map(field => `COALESCE(CAST(${quote(field)} AS CHAR), '') LIKE ? ESCAPE '='`).join(' OR ')})` : ''
    const parameters = query ? CONTROL_FIELDS.map(() => pattern) : []
    const order = `${quote(key)} ${direction}${key === 'id' ? '' : `, \`id\` ${direction}`}`
    const rows = await this.execute(`SELECT ${selection} FROM \`control\`${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...parameters, limit, offset])
    const [count] = await this.execute(`SELECT CAST(COUNT(*) AS CHAR) AS total FROM \`control\`${where}`, parameters)
    return { columns: CONTROL_COLUMNS.map(column => ({ ...column })), rows: rows.map(rowValue), total: totalValue(count?.total) }
  }

  async get(id) {
    validateId(id)
    const [row] = await this.execute(`SELECT ${selection} FROM \`control\` WHERE \`id\` = ?`, [id])
    if (!row) throw missing()
    return rowValue(row)
  }

  async create(values) {
    const entries = validateValues(values, { create: true })
    const result = await this.execute(`INSERT INTO \`control\` (${entries.map(([key]) => quote(key)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`, entries.map(([, value]) => value))
    return this.get(storedId(result.insertId, { insert: true }))
  }

  async update(id, values) {
    validateId(id)
    const entries = validateValues(values)
    await this.execute(`UPDATE \`control\` SET ${entries.map(([key]) => `${quote(key)} = ?`).join(', ')} WHERE \`id\` = ?`, [...entries.map(([, value]) => value), id])
    return this.get(id)
  }

  async lockedFiles(connection, id) {
    const [row] = await this.execute('SELECT `files` FROM `control` WHERE `id` = ? FOR UPDATE', [id], connection)
    if (!row) throw missing()
    return readFiles(row.files)
  }

  async delete(id) {
    validateId(id)
    return this.transaction(async connection => {
      const files = await this.lockedFiles(connection, id)
      if (files.length) throw new ApplicationError(9, 'Remove record attachments before deleting the record')
      const result = await this.execute('DELETE FROM `control` WHERE `id` = ?', [id], connection)
      if (!result.affectedRows) throw missing()
      return { deleted: true }
    })
  }

  async addFiles(id, metadata) {
    validateId(id)
    const added = validateFiles(metadata)
    return this.transaction(async connection => {
      const files = await this.lockedFiles(connection, id)
      const ids = new Set(files.map(file => file.id))
      if (added.some(file => ids.has(file.id))) throw new ApplicationError(6, 'Control file already exists')
      if (files.length + added.length > MAX_ROW_FILES) throw new ApplicationError(8, 'Control record attachment limit exceeded')
      await this.execute('UPDATE `control` SET `files` = ? WHERE `id` = ?', [JSON.stringify([...files, ...added]), id], connection)
      return added
    })
  }

  async getFile(rowId, fileId) {
    validateId(rowId)
    validateFileId(fileId)
    const [row] = await this.execute('SELECT `files` FROM `control` WHERE `id` = ?', [rowId])
    if (!row) throw missing()
    const file = readFiles(row.files).find(file => file.id === fileId)
    if (!file) throw missing()
    return file
  }

  async removeFile(rowId, fileId) {
    validateId(rowId)
    validateFileId(fileId)
    return this.transaction(async connection => {
      const files = await this.lockedFiles(connection, rowId)
      const file = files.find(file => file.id === fileId)
      if (!file) throw missing()
      await this.execute('UPDATE `control` SET `files` = ? WHERE `id` = ?', [JSON.stringify(files.filter(file => file.id !== fileId)), rowId], connection)
      return file
    })
  }
}
