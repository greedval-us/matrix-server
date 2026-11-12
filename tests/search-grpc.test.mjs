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

async function fixture(t, respond, { databases = [{ id: 7, name_table: 'source_7', name: 'Источник 7' }], repository } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'matrix-stream-'))
  const catalogPath = path.join(directory, 'catalog.json')
  const statusPath = path.join(directory, 'state.json')
  await writeFile(catalogPath, JSON.stringify({ databases }))
  await writeFile(statusPath, JSON.stringify({ status: 'completed', completed_shards: [0], total_shards: 1 }))
  const http = createServer(async (request, response) => {
    const buffers = []
    for await (const chunk of request) buffers.push(chunk)
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(respond(JSON.parse(Buffer.concat(buffers)))))
  })
  http.listen(0, '127.0.0.1'); await once(http, 'listening')
  const settings = readSettings({ MATRIX_API_KEY: 'reader', MATRIX_MODULES: 'search', MANTICORE_URL: `http://127.0.0.1:${http.address().port}`, MATRIX_DATABASE_CATALOG: catalogPath, MANTICORE_INDEX_STATE: statusPath })
  const application = await createApplication(settings, { repository })
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

test('search displays current descriptions only for sources that match the published identity', async t => {
  const databases = [
    { id: 7, name_table: 'source_7', name: 'Название из снимка', info: 'Описание из снимка', type: 'Тип из снимка', country: 'Страна из снимка', count: 42 },
    { id: 8, name_table: 'source_8', name: 'Источник 8', info: 'Описание 8' },
    { id: 9, name_table: 'source_9', name: 'Источник 9', info: 'Описание 9' },
  ]
  const liveRows = new Map([
    ['7', { id: '7', name_table: 'source_7', name: 'Текущее название', info: 'Текущее описание', type: 'Новый тип' }],
    ['8', { id: '8', name_table: 'renamed_table', name: 'Другой источник', info: 'Чужое описание' }],
  ])
  const batches = []
  const repository = {
    async searchSourceMetadata(ids) {
      const keys = ids.map(String)
      batches.push(keys)
      return keys.flatMap(id => liveRows.has(id) ? [liveRows.get(id)] : [])
    },
    async appendLog() {},
  }
  const hit = (database, row) => ({ _id: ((BigInt(database) << 32n) + BigInt(row)).toString(), _source: { payload: '{}' } })
  const search = await fixture(t, request => request.options.scroll === true
    ? { hits: { total: 5, hits: [hit(7, 1), hit(8, 1), hit(7, 2)] }, scroll: 'next' }
    : { hits: { total: 5, hits: [hit(7, 3), hit(9, 1)] } }, { databases, repository })
  const request = { number: '79991234567', limit: 3 }
  const chunks = await search(request)
  const sources = chunks.flatMap(chunk => chunk.object_data_base ? [chunk.object_data_base] : [])
  assert.deepEqual(sources.map(({ name_table, name, info }) => [name_table, name, info]), [
    ['source_7', 'Текущее название', 'Текущее описание'],
    ['source_8', 'Источник 8', 'Описание 8'],
    ['source_9', 'Источник 9', 'Описание 9'],
  ])
  assert.equal(sources[0].type, 'Тип из снимка')
  assert.equal(sources[0].country, 'Страна из снимка')
  assert.equal(sources[0].count, '42')
  assert.deepEqual(chunks.flatMap(chunk => chunk.object_data ? [chunk.object_data.source_name] : []), [
    'source_7', 'source_8', 'source_7', 'source_7', 'source_9',
  ])

  liveRows.set('7', { ...liveRows.get('7'), name: 'Исправленное название', info: null })
  const { object_data_base: edited } = (await search(request)).find(chunk => chunk.object_data_base)
  assert.equal(edited.name_table, 'source_7')
  assert.equal(edited.name, 'Исправленное название')
  assert.equal(edited.info, '')
  assert.deepEqual(batches, [['7', '8'], ['9'], ['7', '8'], ['9']])
})

test('search sends current field labels once before rows and preserves the original keys', async t => {
  const databases = [
    { id: 7, name_table: 'source_7', name: 'Источник 7' },
    { id: 8, name_table: 'source_8', name: 'Источник 8' },
  ]
  let reads = 0
  let label = 'Дополнительный номер'
  const repository = {
    async searchFieldLabels() {
      reads += 1
      return [{ field_key: 'extra_number', label }]
    },
    async appendLog() {},
  }
  const hit = (id, row) => ({
    _id: ((BigInt(id) << 32n) + BigInt(row)).toString(),
    _source: { payload: JSON.stringify({ extra_number: '12345' }) },
  })
  const search = await fixture(t, request => request.options.scroll === true
    ? { hits: { total: 3, hits: [hit(7, 1), hit(7, 2)] }, scroll: 'next' }
    : { hits: { total: 3, hits: [hit(8, 1)] } }, { databases, repository })
  const request = { number: '79991234567', limit: 2 }
  const chunks = await search(request)
  assert.equal(reads, 1)
  assert.equal(chunks[0].object_data_base.name_table, 'source_7')
  assert.deepEqual(chunks[0].field_labels, { extra_number: 'Дополнительный номер' })
  assert.equal(chunks.filter(chunk => Object.keys(chunk.field_labels ?? {}).length).length, 1)
  assert.deepEqual(chunks.flatMap(chunk => chunk.object_data ? [[chunk.object_data.source_name, chunk.object_data.fields.extra_number]] : []), [
    ['source_7', '12345'], ['source_7', '12345'], ['source_8', '12345'],
  ])

  label = 'Обновлённая подпись'
  assert.deepEqual((await search(request))[0].field_labels, { extra_number: label })
  assert.equal(reads, 2)
})

test('search dependency errors cannot leak upstream response data through gRPC details', async t => {
  const search = await fixture(t, () => ({ error: 'private upstream SQL value and password' }))
  await assert.rejects(search({ number: '79991234567' }), error => error.code === grpc.status.UNAVAILABLE && !error.details.includes('private'))
})
