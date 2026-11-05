import { readFile } from 'node:fs/promises'

const SEARCH_DATABASE_FIELDS = Object.freeze([
  'name_table', 'name', 'info', 'type', 'country', 'count', 'relevance_date', 'trust',
])

const DATABASE_LIST_FIELDS = Object.freeze([
  'name_table', 'name', 'info', 'country', 'access_level', 'count', 'search_mail',
  'search_fio', 'search_number', 'search_telegram', 'search_passport', 'search_snils',
  'search_inn', 'search_imei', 'search_imsi', 'search_facebook', 'search_vk',
  'search_grz', 'search_vin', 'type', 'trust', 'updated_at', 'created_at',
  'relevance_date',
])

function stringRecord(source, fields) {
  return Object.fromEntries(fields.map((field) => [
    field,
    source?.[field] == null ? '' : String(source[field]),
  ]))
}

export async function readDatabaseCatalog(path) {
  let document
  try {
    document = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`Database catalog is unavailable: ${error.message}`)
  }
  if (!Array.isArray(document.databases)) {
    throw new Error('Database catalog has an invalid format')
  }

  return formatDatabaseCatalog(document.databases)
}

export function formatDatabaseCatalog(rows) {
  const databases = rows.map((database) => ({
    id: Number.parseInt(database.id, 10),
    search: stringRecord(database, SEARCH_DATABASE_FIELDS),
    list: stringRecord(database, DATABASE_LIST_FIELDS),
  }))
  if (databases.some((database) => !Number.isSafeInteger(database.id) || database.id <= 0)) {
    throw new Error('Database catalog contains an invalid database id')
  }

  return {
    databases,
    byId: new Map(databases.map((database) => [database.id, database])),
  }
}
