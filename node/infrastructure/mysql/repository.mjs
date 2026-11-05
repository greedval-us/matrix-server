import { CATALOG_FIELDS, RESOURCES } from '../../modules/workspace/resources.mjs'

const UINT64_MAX = 18446744073709551615n
const CATALOG_MAX = 4294967295n
const fail = (code, message) => Object.assign(new Error(message), { code })
const invalid = () => fail(3, 'Invalid operational resource request')
const quoted = value => `\`${value}\``

function definition(resource, write = false) {
  if (!Object.hasOwn(RESOURCES, resource)) throw invalid()
  const result = RESOURCES[resource]
  if (write && result.writable.length === 0) throw fail(7, 'Resource is read-only')
  return result
}

function idValue(id, resource) {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) throw invalid()
  if (BigInt(id) > (resource === 'data_base' ? CATALOG_MAX : UINT64_MAX)) throw invalid()
  return id
}

function writeValues(resource, values, create) {
  const spec = definition(resource, true)
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw invalid()
  const entries = Object.entries(values)
  if (!entries.length) throw invalid()
  for (const [field, value] of entries) {
    if (!spec.writable.includes(field) || typeof value !== 'string') throw invalid()
    if (!create && resource === 'data_base' && ['id', 'name_table'].includes(field)) throw invalid()
    if (field === 'id') idValue(value, resource)
    else if (field === 'name_table') {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(value)) throw invalid()
    } else if (field === 'count') {
      if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > UINT64_MAX) throw invalid()
    } else if (field.startsWith('search_')) {
      if (!['0', '1'].includes(value)) throw invalid()
    } else if (field === 'payload') {
      if (Buffer.byteLength(value) > 1_048_576) throw invalid()
      try { JSON.parse(value) } catch { throw invalid() }
    } else {
      const maximum = field === 'info' ? 65_535 : field === 'namespace' ? 128 : 255
      if (value.length > maximum || (resource === 'work_items' && ['namespace', 'name'].includes(field) && !value.trim())) throw invalid()
    }
  }
  if (create && spec.required.some(field => !Object.hasOwn(values, field))) throw invalid()
  return entries
}

function rowValue(row) {
  return {
    id: String(row.id),
    values: Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'id').map(([field, value]) => [
      field, value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value),
    ])),
  }
}

export class OperationalRepository {
  constructor(pool, { catalogGuard = async () => {} } = {}) {
    this.pool = pool
    this.catalogGuard = catalogGuard
  }

  async execute(sql, parameters = []) {
    try {
      const [result] = await this.pool.execute(sql, parameters)
      return result
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') throw fail(6, 'Operational row already exists')
      throw fail(14, 'Operational database is unavailable')
    }
  }

  async list(resource, { limit = 100, offset = 0 } = {}) {
    const spec = definition(resource)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw invalid()
    const rows = await this.execute(`SELECT ${spec.fields.map(quoted).join(', ')} FROM ${quoted(resource)} ORDER BY \`id\` LIMIT ? OFFSET ?`, [limit, offset])
    const [count] = await this.execute(`SELECT CAST(COUNT(*) AS CHAR) AS total FROM ${quoted(resource)}`)
    return { rows: rows.map(rowValue), total: String(count.total) }
  }

  async get(resource, id) {
    const spec = definition(resource)
    idValue(id, resource)
    const [row] = await this.execute(`SELECT ${spec.fields.map(quoted).join(', ')} FROM ${quoted(resource)} WHERE \`id\` = ?`, [id])
    if (!row) throw fail(5, 'Operational row was not found')
    return rowValue(row)
  }

  async create(resource, values) {
    const entries = writeValues(resource, values, true)
    if (resource === 'data_base') await this.catalogGuard({ operation: 'create', id: values.id })
    const result = await this.execute(`INSERT INTO ${quoted(resource)} (${entries.map(([field]) => quoted(field)).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`, entries.map(([, value]) => value))
    // mysql2 decodes the OK packet insert-id as signed even for UNSIGNED
    // columns. Restore its unsigned representation without using Number.
    const generatedId = String(result.insertId)
    const id = /^-[1-9][0-9]*$/.test(generatedId)
      ? BigInt.asUintN(64, BigInt(generatedId)).toString() : generatedId
    return this.get(resource, values.id ?? id)
  }

  async update(resource, id, values) {
    const entries = writeValues(resource, values, false)
    idValue(id, resource)
    await this.execute(`UPDATE ${quoted(resource)} SET ${entries.map(([field]) => `${quoted(field)} = ?`).join(', ')} WHERE \`id\` = ?`, [...entries.map(([, value]) => value), id])
    return this.get(resource, id)
  }

  async delete(resource, id) {
    definition(resource, true)
    idValue(id, resource)
    if (resource === 'data_base') await this.catalogGuard({ operation: 'delete', id })
    const result = await this.execute(`DELETE FROM ${quoted(resource)} WHERE \`id\` = ?`, [id])
    if (!result.affectedRows) throw fail(5, 'Operational row was not found')
    return { deleted: true }
  }

  async catalogRows() {
    return this.execute(`SELECT ${CATALOG_FIELDS.map(quoted).join(', ')} FROM \`data_base\` ORDER BY \`id\``)
  }

  async appendLog({ module, method, statusCode, durationMs }) {
    if (![module, method].every(value => typeof value === 'string' && /^[A-Za-z0-9_.\/]{1,128}$/.test(value))
      || !Number.isInteger(statusCode) || statusCode < 0 || statusCode > 16
      || !Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 4294967295) throw invalid()
    await this.execute('INSERT INTO `service_logs` (`module`, `method`, `status_code`, `duration_ms`) VALUES (?, ?, ?, ?)', [module, method, statusCode, durationMs])
  }
}
