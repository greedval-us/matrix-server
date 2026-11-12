import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../core/errors.mjs'
import { normalizeCatalogTypeName } from '../infrastructure/mysql/catalog-types.mjs'

export const CATALOG_EDIT_FIELDS = Object.freeze(['name', 'info', 'relevance_date', 'country', 'type', 'trust'])

const listFields = ['id', 'name_table', 'name', 'country', 'type']
const detailFields = ['id', 'name_table', ...CATALOG_EDIT_FIELDS]
const pageSize = 50
const maxId = 4294967295
const column = field => `\`${field}\``
const columns = fields => fields.map(column).join(', ')
const invalid = () => new ApplicationError(grpc.status.INVALID_ARGUMENT, 'Invalid catalog editor request')

function validId(id) {
  return typeof id === 'string' && /^[1-9][0-9]{0,9}$/.test(id) && Number(id) <= maxId
}

function catalogRow(row, fields) {
  const values = Object.fromEntries(fields.map(field => [field, row[field] ?? null]))
  return { ...values, id: String(row.id) }
}

function searchFilter(query) {
  if (typeof query !== 'string') throw invalid()
  const text = query.trim()
  if (!text.isWellFormed() || [...text].length > 255) throw invalid()
  if (!text) return { condition: '', parameters: [] }
  const byId = validId(text)
  const condition = ' WHERE (LOCATE(?, `name`) > 0 OR LOCATE(?, CONVERT(`name_table` USING utf8mb4)) > 0'
  return {
    condition: condition + (byId ? ' OR `id` = ?)' : ')'),
    parameters: byId ? [text, text, text] : [text, text],
  }
}

function editValues(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw invalid()
  const entries = Object.entries(changes)
  if (!entries.length) throw invalid()
  for (const [field, value] of entries) {
    if (!CATALOG_EDIT_FIELDS.includes(field)) throw invalid()
    if (value === null) continue
    if (typeof value !== 'string' || !value.isWellFormed()) throw invalid()
    if (field === 'info' ? Buffer.byteLength(value) > 65535 : [...value].length > 255) throw invalid()
  }
  return entries
}

export function createCatalogEditor(repository) {
  async function get(id) {
    if (!validId(id)) throw invalid()
    const [row] = await repository.execute(`SELECT ${columns(detailFields)} FROM \`data_base\` WHERE \`id\` = ?`, [id])
    if (!row) throw new ApplicationError(grpc.status.NOT_FOUND, 'Catalog row was not found')
    return catalogRow(row, detailFields)
  }

  return {
    async list({ query = '', page = 1 } = {}) {
      if (!Number.isSafeInteger(page) || page < 1) throw invalid()
      const offset = (page - 1) * pageSize
      if (!Number.isSafeInteger(offset)) throw invalid()
      const { condition, parameters } = searchFilter(query)
      const rows = await repository.execute(
        `SELECT ${columns(listFields)} FROM \`data_base\`${condition} ORDER BY \`id\` LIMIT ? OFFSET ?`,
        [...parameters, pageSize, offset],
      )
      const [count] = await repository.execute(`SELECT COUNT(\`id\`) AS total FROM \`data_base\`${condition}`, parameters)
      return { rows: rows.map(row => catalogRow(row, listFields)), total: Number(count.total), page, pageSize }
    },
    async listTypes() {
      const rows = await repository.execute('SELECT `name` FROM `catalog_types` WHERE `alias_for` IS NULL ORDER BY `name`')
      return rows.map(row => row.name)
    },
    async createType(value) {
      const name = normalizeCatalogTypeName(value)
      if (name === null) throw invalid()
      await repository.execute('INSERT INTO `catalog_types` (`name`) VALUES (?)', [name])
      return name
    },
    get,
    async update(id, changes) {
      if (!validId(id)) throw invalid()
      const entries = editValues(changes)
      const type = entries.find(([field]) => field === 'type')
      if (type && type[1] !== null) {
        const name = normalizeCatalogTypeName(type[1])
        if (name === null) throw invalid()
        const [registered] = await repository.execute(
          'SELECT `name` FROM `catalog_types` WHERE `name` = ? AND `alias_for` IS NULL', [name],
        )
        if (!registered) throw invalid()
        type[1] = registered.name
      }
      const assignments = entries.map(([field]) => `${column(field)} = ?`).join(', ')
      await repository.execute(`UPDATE \`data_base\` SET ${assignments} WHERE \`id\` = ?`, [...entries.map(([, value]) => value), id])
      return get(id)
    },
  }
}
