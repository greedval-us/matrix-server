import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('standalone MySQL settings support password files and reject ambiguous secrets and malformed ports', async () => {
  const { readMysqlSettings } = await import('../node/infrastructure/mysql/settings.mjs')
  const directory = await mkdtemp(path.join(tmpdir(), 'matrix-secret-'))
  try {
    const filename = path.join(directory, 'mysql-password')
    await writeFile(filename, 'private-password\n')
    const env = { MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD_FILE: filename }
    const settings = readMysqlSettings(env)
    assert.equal(settings.password, 'private-password')
    assert.equal(settings.database, 'matrix')
    assert.equal(settings.port, 3306)
    assert.throws(() => readMysqlSettings({ ...env, MATRIX_MYSQL_PASSWORD: 'ambiguous' }), /PASSWORD/)
    assert.throws(() => readMysqlSettings({ ...env, MATRIX_MYSQL_PORT: '3306junk' }), /PORT/)
    const source = { SOURCE_MYSQL_HOST: 'source-db', SOURCE_MYSQL_USER: 'reader', SOURCE_MYSQL_PASSWORD: '' }
    assert.equal(readMysqlSettings(source, 'SOURCE_MYSQL').database, 'source_data')
    assert.equal(readMysqlSettings(source, 'SOURCE_MYSQL').host, 'source-db')
    assert.throws(() => readMysqlSettings({ SOURCE_MYSQL_USER: 'reader', SOURCE_MYSQL_PASSWORD: '' }, 'SOURCE_MYSQL'), /SOURCE_MYSQL_HOST/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('pool configuration preserves bigint, JSON and date values without enabling statement injection', async () => {
  const { createMysqlPool } = await import('../node/infrastructure/mysql/pool.mjs')
  let options
  const marker = {}
  assert.equal(createMysqlPool({ host: 'mysql', port: 3306, user: 'matrix', password: 'secret', database: 'matrix', connectionLimit: 4 }, {
    createPool(value) { options = value; return marker },
  }), marker)
  assert.equal(options.supportBigNumbers, true)
  assert.equal(options.bigNumberStrings, true)
  assert.equal(options.dateStrings, true)
  assert.equal(options.jsonStrings, true)
  assert.equal(options.multipleStatements, false)
  assert.equal(options.connectionLimit, 4)
})

function connectionFixture(responder) {
  const calls = []
  const connection = {
    async execute(sql, params = []) { calls.push({ sql, params }); return [await responder(sql, params), []] },
    async query(sql, params = []) { return this.execute(sql, params) },
    async beginTransaction() { calls.push({ action: 'begin' }) },
    async commit() { calls.push({ action: 'commit' }) },
    async rollback() { calls.push({ action: 'rollback' }) },
    release() { calls.push({ action: 'release' }) },
  }
  return { connection, calls, pool: { async getConnection() { return connection } } }
}

test('catalog copy refuses populated destination without reading or changing source', async () => {
  const { copyCatalog } = await import('../scripts/copy_catalog.mjs')
  const { pool, calls } = connectionFixture(sql => sql.includes('GET_LOCK') ? [{ acquired: 1 }] : sql.includes('FOR UPDATE') ? [{ id: 9 }] : [])
  let sourceReads = 0
  await assert.rejects(copyCatalog({ async execute() { sourceReads++; return [[]] } }, pool), /empty/)
  assert.equal(sourceReads, 0)
  assert.ok(calls.some(call => call.action === 'rollback'))
  assert.ok(!calls.some(call => call.sql?.startsWith('INSERT')))
})

test('catalog copy preserves ids and nulls, binds source values and commits atomically', async () => {
  const { copyCatalog } = await import('../scripts/copy_catalog.mjs')
  const { pool, calls } = connectionFixture(sql => sql.includes('GET_LOCK') ? [{ acquired: 1 }] : [])
  const sourceSql = []
  const source = { async execute(sql) { sourceSql.push(sql); return [[{ id: '27', name_table: 'contacts_27', info: null, count: '9007199254740993' }], []] } }
  assert.equal(await copyCatalog(source, pool), 1)
  assert.equal(sourceSql.length, 1)
  assert.match(sourceSql[0], /^SELECT .* FROM `data_base` ORDER BY `id`$/)
  const insert = calls.find(call => call.sql?.startsWith('INSERT'))
  assert.equal(insert.params[0], '27')
  assert.equal(insert.params[3], null)
  assert.equal(insert.params[9], '9007199254740993')
  assert.ok(!insert.sql.includes('contacts_27'))
  assert.ok(calls.some(call => call.action === 'commit'))
  assert.ok(calls.some(call => call.sql?.includes('RELEASE_LOCK')))
})

test('catalog copy rolls back all inserted rows on a later failure and releases its lock', async () => {
  const { copyCatalog } = await import('../scripts/copy_catalog.mjs')
  let inserts = 0
  const { pool, calls } = connectionFixture(sql => {
    if (sql.includes('GET_LOCK')) return [{ acquired: 1 }]
    if (sql.startsWith('INSERT') && ++inserts === 2) throw new Error('write failed')
    return []
  })
  const source = { async execute() { return [[{ id: '1', name_table: 'one' }, { id: '2', name_table: 'two' }], []] } }
  await assert.rejects(copyCatalog(source, pool), /write failed/)
  assert.ok(calls.some(call => call.action === 'rollback'))
  assert.ok(!calls.some(call => call.action === 'commit'))
  assert.ok(calls.some(call => call.sql?.includes('RELEASE_LOCK')))
})

test('migrations record versions once, skip applied files and reject checksum drift', async () => {
  const { runMigrations } = await import('../scripts/migrate.mjs')
  const directory = await mkdtemp(path.join(tmpdir(), 'matrix-migrations-'))
  const versions = []
  const { pool, calls } = connectionFixture((sql, params) => {
    if (sql.includes('GET_LOCK')) return [{ acquired: 1 }]
    if (sql.startsWith('SELECT `version`')) return versions
    if (sql.startsWith('INSERT INTO `schema_migrations`')) versions.push({ version: params[0], checksum: params[1] })
    return []
  })
  try {
    await writeFile(path.join(directory, '001_test.sql'), 'CREATE TABLE `example` (`id` INT);')
    assert.deepEqual(await runMigrations(pool, { directory }), ['001_test.sql'])
    assert.deepEqual(await runMigrations(pool, { directory }), [])
    assert.equal(calls.filter(call => call.sql?.startsWith('CREATE TABLE `example`')).length, 1)
    await writeFile(path.join(directory, '001_test.sql'), 'CREATE TABLE `changed` (`id` INT);')
    await assert.rejects(runMigrations(pool, { directory }), /checksum/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
