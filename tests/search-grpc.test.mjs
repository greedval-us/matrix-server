import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { createApplication } from '../node/application.mjs'
import { readSettings } from '../node/config.mjs'

async function fixture(t, respond) {
  const directory = await mkdtemp(path.join(tmpdir(), 'matrix-stream-'))
  const catalogPath = path.join(directory, 'catalog.json')
  const statusPath = path.join(directory, 'state.json')
  await writeFile(catalogPath, JSON.stringify({ databases: [{ id: 7, name_table: 'source_7', name: 'Источник 7' }] }))
  await writeFile(statusPath, JSON.stringify({ status: 'completed', completed_shards: [0], total_shards: 1 }))
  const http = createServer(async (request, response) => {
    const buffers = []
    for await (const chunk of request) buffers.push(chunk)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(respond(JSON.parse(Buffer.concat(buffers)))))
  })
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const settings = readSettings({ MATRIX_API_KEY: 'reader', MATRIX_MODULES: 'search', MANTICORE_URL: `http://127.0.0.1:${http.address().port}`, MATRIX_DATABASE_CATALOG: catalogPath, MANTICORE_INDEX_STATE: statusPath })
  const application = await createApplication(settings)
  const port = await new Promise((resolve, reject) => application.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, result) => error ? reject(error) : resolve(result)))
  const definition = protoLoader.loadSync(fileURLToPath(new URL('../protos/base_search.proto', import.meta.url)), { keepCase: true, longs: String, defaults: true })
  const client = new (grpc.loadPackageDefinition(definition).base_search.BaseSearches)(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
  t.after(async () => {
    client.close(); await application.close()
    await new Promise(resolve => http.close(resolve))
    await rm(directory, { recursive: true, force: true })
  })
  return request => new Promise((resolve, reject) => {
    const metadata = new grpc.Metadata(); metadata.set('x-api-key', 'reader')
    const rows = []
    const stream = client.streamSearch(request, metadata, { deadline: Date.now() + 3000 })
    stream.on('data', row => rows.push(row)); stream.on('end', () => resolve(rows)); stream.on('error', reject)
  })
}

test('modular search preserves every streamed page, source identity and completion counters', async t => {
  const requests = []
  const hit = id => ({ _id: ((7n << 32n) + BigInt(id)).toString(), _source: { payload: JSON.stringify({ id, number: '79991234567', fio: 'Имя' }) } })
  const search = await fixture(t, request => {
    requests.push(request)
    return request.options.scroll === true
      ? { hits: { total: 3, hits: [hit(1), hit(2)] }, took: 1, scroll: 'page2' }
      : { hits: { total: 3, hits: [hit(3)] }, took: 2, scroll: 'done' }
  })
  const chunks = await search({ number: '79991234567', limit: 2 })
  assert.equal(requests.length, 2)
  assert.deepEqual(chunks.filter(item => item.object_data).map(item => item.object_data.fields.id), ['1', '2', '3'])
  assert.equal(chunks.filter(item => item.object_data_base).length, 1)
  assert.equal(chunks.at(-1).meta.returned_hits, '3')
  assert.equal(chunks.at(-1).meta.total_hits, '3')
  assert.equal(chunks.at(-1).meta.partial, false)
})

test('search dependency errors cannot leak upstream response data through gRPC details', async t => {
  const search = await fixture(t, () => ({ error: 'private upstream SQL value and password' }))
  await assert.rejects(search({ number: '79991234567' }), error => error.code === grpc.status.UNAVAILABLE && !error.details.includes('private'))
})
