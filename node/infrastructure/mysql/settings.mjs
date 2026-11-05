import { readFileSync } from 'node:fs'

function integer(env, name, fallback, maximum) {
  const raw = env[name] ?? String(fallback)
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) throw new Error(`Invalid ${name}`)
  return Number(raw)
}

export function readMysqlSettings(env = process.env, prefix = 'MATRIX_MYSQL') {
  if (!['MATRIX_MYSQL', 'SOURCE_MYSQL'].includes(prefix)) throw new Error('Invalid MySQL environment prefix')
  const source = prefix === 'SOURCE_MYSQL'
  const user = (env[`${prefix}_USER`] ?? '').trim()
  const host = (env[`${prefix}_HOST`] ?? (source ? '' : '127.0.0.1')).trim()
  const database = (env[`${prefix}_DATABASE`] ?? (source ? 'source_data' : 'matrix')).trim()
  if (!user || !host || !/^[A-Za-z0-9_]{1,64}$/.test(database)) throw new Error(`Configure valid ${prefix}_HOST, USER and DATABASE`)
  const passwordName = `${prefix}_PASSWORD`
  const filename = env[`${passwordName}_FILE`]
  if (filename && env[passwordName] !== undefined) throw new Error(`Use either ${passwordName} or ${passwordName}_FILE`)
  let password = env[passwordName]
  if (filename) {
    try { password = readFileSync(filename, 'utf8').replace(/\r?\n$/, '') }
    catch { throw new Error(`Cannot read ${passwordName}_FILE`) }
  }
  if (password === undefined) throw new Error(`Configure ${passwordName} or ${passwordName}_FILE`)
  return Object.freeze({
    host, user, database, password,
    port: integer(env, `${prefix}_PORT`, 3306, 65535),
    connectionLimit: integer(env, `${prefix}_CONNECTION_LIMIT`, 10, 100),
  })
}
