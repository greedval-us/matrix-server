import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readSettings } from '../node/config.mjs'

const environment = { MATRIX_API_KEY: 'search-test-key' }

test('local default uses portable state paths and existing read-only modules', () => {
  const settings = readSettings(environment)
  assert.deepEqual(settings.moduleIds, ['search', 'catalog'])
  assert.equal(settings.mysql, null)
  assert.equal(settings.indexStatePath, path.resolve('data/state/indexer.json'))
})

test('workspace needs its own key and operational MySQL', () => {
  const env = { ...environment, MATRIX_MODULES: 'search,catalog,workspace' }
  assert.throws(() => readSettings(env), /MYSQL|MySQL/)
  const database = { ...env, MATRIX_MYSQL_HOST: 'mysql', MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD: 'db-secret', MATRIX_MYSQL_DATABASE: 'matrix' }
  assert.throws(() => readSettings(database), /ADMIN_API_KEY/)
  assert.throws(() => readSettings({ ...database, MATRIX_ADMIN_API_KEY: environment.MATRIX_API_KEY }), /different/)
  const settings = readSettings({ ...database, MATRIX_ADMIN_API_KEY: 'admin-test-key' })
  assert.equal(settings.mysql.host, 'mysql')
  assert.equal(settings.mysql.database, 'matrix')
})

test('configuration rejects unknown modules and malformed numeric limits', () => {
  assert.throws(() => readSettings({ ...environment, MATRIX_MODULES: 'search,arbitrary' }), /module/)
  assert.throws(() => readSettings({ ...environment, MATRIX_GRPC_PORT: '50051trailing' }), /MATRIX_GRPC_PORT/)
  assert.throws(() => readSettings({ ...environment, MATRIX_SEARCH_PAGE_SIZE: '0' }), /MATRIX_SEARCH_PAGE_SIZE/)
})

test('API and migration settings preserve the same MySQL password bytes', async () => {
  const { readMysqlSettings } = await import('../node/infrastructure/mysql/settings.mjs')
  const env = { ...environment, MATRIX_MYSQL_HOST: 'mysql', MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD: ' padded secret ' }
  assert.equal(readSettings(env).mysql.password, readMysqlSettings(env).password)
  assert.equal(readSettings(env).mysql.password, ' padded secret ')
})

test('keys may be read from secret files without ambiguous precedence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'matrix-settings-'))
  try {
    const secret = path.join(directory, 'api-key')
    await writeFile(secret, 'file-key\n')
    assert.equal(readSettings({ MATRIX_API_KEY_FILE: secret }).apiKey, 'file-key')
    assert.throws(() => readSettings({ ...environment, MATRIX_API_KEY_FILE: secret }), /both|together/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
