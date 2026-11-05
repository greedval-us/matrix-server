import path from 'node:path'
import { readFileSync } from 'node:fs'
import { readMysqlSettings } from './infrastructure/mysql/settings.mjs'
import { modules } from './modules/index.mjs'

function positiveInteger(environment, name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const input = String(environment[name] ?? fallback)
  const value = Number(input)
  if (!/^\d+$/.test(input) || !Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`)
  return value
}

function secret(environment, name) {
  const value = environment[name]
  const file = environment[`${name}_FILE`]
  if (value && file) throw new Error(`Do not configure both ${name} and ${name}_FILE`)
  if (!file) return String(value ?? '').trim()
  try { return readFileSync(file, 'utf8').trim() }
  catch { throw new Error(`Cannot read ${name}_FILE`) }
}

export function readSettings(environment = process.env) {
  const apiKey = secret(environment, 'MATRIX_API_KEY')
  if (!apiKey) throw new Error('MATRIX_API_KEY must be configured')
  const moduleIds = String(environment.MATRIX_MODULES ?? 'search,catalog').split(',').map(value => value.trim()).filter(Boolean)
  if (!moduleIds.length || new Set(moduleIds).size !== moduleIds.length || moduleIds.some(id => !modules.some(module => module.id === id))) throw new Error('MATRIX_MODULES contains an unknown or duplicate module')
  const mysql = environment.MATRIX_MYSQL_HOST ? readMysqlSettings(environment) : null
  if (moduleIds.some(id => ['workspace', 'records'].includes(id)) && !mysql) throw new Error('workspace/records modules require operational MySQL (MATRIX_MYSQL_HOST)')
  const adminApiKey = secret(environment, 'MATRIX_ADMIN_API_KEY')
  if (moduleIds.includes('workspace') && !adminApiKey) throw new Error('MATRIX_ADMIN_API_KEY is required by the workspace module')
  if (adminApiKey && adminApiKey === apiKey) throw new Error('MATRIX_ADMIN_API_KEY must be different from MATRIX_API_KEY')
  const tlsCertPath = String(environment.MATRIX_GRPC_TLS_CERT ?? '').trim()
  const tlsKeyPath = String(environment.MATRIX_GRPC_TLS_KEY ?? '').trim()
  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) throw new Error('MATRIX_GRPC_TLS_CERT and MATRIX_GRPC_TLS_KEY must be configured together')
  return Object.freeze({
    grpcHost: environment.MATRIX_GRPC_HOST ?? '127.0.0.1',
    grpcPort: positiveInteger(environment, 'MATRIX_GRPC_PORT', 50051, 65535),
    apiKey, adminApiKey, moduleIds: Object.freeze(moduleIds), mysql,
    recordsFileDirectory: path.resolve(environment.MATRIX_RECORDS_FILE_DIR ?? 'data/files'),
    manticoreUrl: String(environment.MANTICORE_URL ?? 'http://127.0.0.1:9308').replace(/\/+$/, ''),
    manticoreTable: environment.MANTICORE_TABLE ?? 'matrix_records',
    indexStatePath: path.resolve(environment.MANTICORE_INDEX_STATE ?? 'data/state/indexer.json'),
    databaseCatalogPath: path.resolve(environment.MATRIX_DATABASE_CATALOG ?? 'data/state/database-catalog.json'),
    searchPageSize: positiveInteger(environment, 'MATRIX_SEARCH_PAGE_SIZE', environment.MATRIX_MAX_RESULTS ?? 1000, 10_000),
    maxQueryTimeMs: positiveInteger(environment, 'MATRIX_MAX_QUERY_TIME_MS', 5000, 60_000),
    maxConcurrentSearches: positiveInteger(environment, 'MATRIX_MAX_CONCURRENT_SEARCHES', 16, 256),
    tlsCertPath, tlsKeyPath,
  })
}
