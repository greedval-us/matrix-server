import assert from 'node:assert/strict'
import test from 'node:test'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'node:url'
import { createApplication } from '../node/application.mjs'
import { readSettings } from '../node/config.mjs'

function clientFor(file, name, endpoint) {
  const definition = protoLoader.loadSync(fileURLToPath(new URL(`../protos/${file}`, import.meta.url)), { keepCase: true, longs: String, defaults: true })
  const Type = name.split('.').reduce((value, key) => value[key], grpc.loadPackageDefinition(definition))
  return new Type(endpoint, grpc.credentials.createInsecure())
}
function request(client, method, payload, key) {
  const metadata = new grpc.Metadata()
  if (key) metadata.set('x-api-key', key)
  return new Promise((resolve, reject) => client[method](payload, metadata, { deadline: Date.now() + 3000 }, (error, result) => error ? reject(error) : resolve(result)))
}

test('real gRPC preserves catalog reads and isolates admin CRUD with safe errors and logs', async () => {
  const calls = []
  const logs = []
  const repository = {
    catalogRows: async () => [{ id: '7', name_table: 'source_people', name: 'Источник' }],
    list: async (resource, options) => { calls.push({ resource, options }); return { rows: [{ id: '9007199254740993', values: { name: 'Заметка' } }], total: '1' } },
    create: async () => { throw new Error('sensitive SQL and db password') },
    appendLog: async value => logs.push(value),
  }
  const settings = readSettings({ MATRIX_API_KEY: 'reader', MATRIX_ADMIN_API_KEY: 'writer', MATRIX_MODULES: 'catalog,workspace', MATRIX_MYSQL_HOST: 'mysql', MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD: 'secret', MATRIX_MYSQL_DATABASE: 'matrix' })
  const application = await createApplication(settings, { repository })
  const port = await new Promise((resolve, reject) => application.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)))
  const workspace = clientFor('workspace.proto', 'matrix.workspace.v1.Workspace', `127.0.0.1:${port}`)
  const catalog = clientFor('database_all.proto', 'database_all.DatabaseAll', `127.0.0.1:${port}`)
  try {
    await assert.rejects(request(workspace, 'listRows', { resource: 'work_items' }, 'reader'), { code: grpc.status.UNAUTHENTICATED })
    assert.equal(calls.length, 0)
    const response = await request(workspace, 'listRows', { resource: 'work_items', limit: 25 }, 'writer')
    assert.equal(response.rows[0].id, '9007199254740993')
    assert.equal(calls[0].options.limit, 25)
    await assert.rejects(request(workspace, 'createRow', { resource: 'work_items', values: { name: 'x' } }, 'writer'), error => error.code === grpc.status.INTERNAL && !error.details.includes('sensitive'))
    const rows = await new Promise((resolve, reject) => {
      const metadata = new grpc.Metadata(); metadata.set('x-api-key', 'reader')
      const result = []
      const stream = catalog.streamDatabaseAll({}, metadata, { deadline: Date.now() + 3000 })
      stream.on('data', item => result.push(item)); stream.on('error', reject); stream.on('end', () => resolve(result))
    })
    assert.equal(rows[0].name, 'Источник')
  } finally {
    workspace.close(); catalog.close(); await application.close()
  }
  assert.ok(logs.some(log => log.module === 'workspace' && log.statusCode === grpc.status.UNAUTHENTICATED))
  assert.ok(logs.some(log => log.module === 'catalog' && log.statusCode === grpc.status.OK))
  assert.ok(logs.every(log => !JSON.stringify(log).includes('secret') && !JSON.stringify(log).includes('Заметка')))
})

test('search module exposes index status with existing protobuf without requiring a database', async () => {
  const settings = readSettings({ MATRIX_API_KEY: 'reader', MATRIX_MODULES: 'search' })
  const app = await createApplication(settings)
  const port = await new Promise((resolve, reject) => app.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)))
  const client = clientFor('base_search.proto', 'base_search.BaseSearches', `127.0.0.1:${port}`)
  try {
    await assert.rejects(request(client, 'getIndexStatus', {}, 'wrong'), { code: grpc.status.UNAUTHENTICATED })
    const status = await request(client, 'getIndexStatus', {}, 'reader')
    assert.equal(status.status, 'not_started')
    assert.equal(status.current_shard, -1)
  } finally { client.close(); await app.close() }
})
