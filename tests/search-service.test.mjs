import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import grpc from '@grpc/grpc-js'
import { SearchService } from '../node/modules/search/search.mjs'
import { MatrixSearchService } from '../node/service.mjs'
import { ManticoreError } from '../node/modules/search/manticore.mjs'

const settings = { apiKey: 'reader', maxConcurrentSearches: 1, searchPageSize: 2 }
const database = { search: { name_table: 'source_7' } }
const status = { indexedShards: 1, totalShards: 1, partial: false }
const hit = (id, databaseId = 7) => ({ _id: ((BigInt(databaseId) << 32n) + BigInt(id)).toString(), _source: { payload: { number: '79991234567', fio: 'Имя' } } })
const dependencies = {
  readCatalog: async () => ({ byId: new Map([[7, database]]) }),
  readStatus: async () => status,
}
const collect = async iterable => { const items = []; for await (const item of iterable) items.push(item); return items }

test('search use case emits sources, all pages, suggestions and counters without a gRPC call', async () => {
  const manticore = { async *searchAll(expression, size) {
    assert.match(expression, /79991234567/)
    assert.equal(size, 2)
    yield { hits: [hit(1), hit(2)], total: 3, tookMs: 1 }
    yield { hits: [hit(3)], total: 3, tookMs: 2 }
  } }
  const service = new SearchService(settings, { ...dependencies, manticore })
  const messages = await collect(service.search({ number: '79991234567' }))
  assert.equal(messages.filter(item => item.object_data_base).length, 1)
  assert.deepEqual(messages.filter(item => item.object_data).map(item => item.object_data.fields.id), ['1', '2', '3'])
  assert.deepEqual(messages.at(-2), { object_add_search: { item: [{ key: 'fio', value: 'Имя' }] } })
  assert.deepEqual(messages.at(-1).meta, { total_hits: '3', returned_hits: '3', indexed_shards: 1, total_shards: 1, partial: false, took_ms: 3 })
  assert.equal(service.capacity.active, 0)
})

test('search keeps published descriptions when operational MySQL is unavailable', async () => {
  const published = { name_table: 'source_7', name: 'Опубликованное название', info: 'Описание' }
  const other = { name_table: 'source_8', name: 'Другой источник' }
  const calls = []
  const service = new SearchService(settings, {
    ...dependencies,
    readCatalog: async () => ({ byId: new Map([[7, { search: published }], [8, { search: other }]]) }),
    readSourceMetadata: async ids => {
      calls.push(ids)
      throw Object.assign(new Error('MySQL unavailable'), { code: grpc.status.UNAVAILABLE })
    },
    manticore: { async *searchAll() {
      yield { hits: [hit(1)], total: 2, tookMs: 1 }
      yield { hits: [hit(2, 8)], total: 2, tookMs: 1 }
    } },
  })
  const messages = await collect(service.search({ number: '79991234567' }))
  assert.deepEqual(calls, [[7]])
  assert.deepEqual(messages.filter(item => item.object_data_base).map(item => item.object_data_base), [published, other])
  assert.deepEqual(messages.filter(item => item.object_data).map(item => item.object_data.source_name), ['source_7', 'source_8'])
  assert.equal(messages.at(-1).meta.returned_hits, '2')
})

test('capacity spans lazy consumption and is released when a consumer stops early', async () => {
  let released = false
  const manticore = { async *searchAll() {
    try { yield { hits: [hit(1)], total: 1, tookMs: 1 } }
    finally { released = true }
  } }
  const service = new SearchService(settings, { ...dependencies, manticore })
  const first = service.search({ number: '79991234567' })
  await first.next()
  await assert.rejects(collect(service.search({ number: '79991234567' })), { code: grpc.status.RESOURCE_EXHAUSTED })
  await first.return()
  assert.equal(released, true)
  assert.equal(service.capacity.active, 0)
  assert.equal((await collect(service.search({ number: '79991234567' }))).at(-1).meta.returned_hits, '1')
})

test('query and dependency errors are classified and cancellation releases capacity', async () => {
  const controller = new AbortController()
  const service = new SearchService(settings, {
    ...dependencies,
    manticore: { async *searchAll(_query, _size, { signal }) {
      assert.equal(signal, controller.signal)
      throw new ManticoreError('private dependency detail')
    } },
  })
  await assert.rejects(collect(service.search({ number: '12%' })), { code: grpc.status.INVALID_ARGUMENT })
  await assert.rejects(collect(service.search({ number: '79991234567' }, { signal: controller.signal })), { code: grpc.status.UNAVAILABLE })
  assert.equal(service.capacity.active, 0)
  controller.abort()
  assert.deepEqual(await collect(service.search({ number: '79991234567' }, { signal: controller.signal })), [])
})

test('legacy search adapter keeps shared-key authorization and sanitizes dependency failures', async () => {
  const service = new MatrixSearchService(settings, { ...dependencies,
    manticore: { async *searchAll() { throw new ManticoreError('private dependency detail') } },
  })
  const call = key => Object.assign(new EventEmitter(), {
    request: { number: '79991234567' },
    metadata: { get: () => [key] },
    write() { assert.fail('failed search wrote a result') },
    end() { assert.fail('failed search ended successfully') },
  })
  for (const [key, code] of [['wrong', grpc.status.UNAUTHENTICATED], ['reader', grpc.status.UNAVAILABLE]]) {
    const stream = call(key)
    const errors = []
    stream.on('error', error => errors.push(error))
    await service.streamSearch(stream)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].code, code)
    assert.ok(!errors[0].message.includes('private'))
  }
})

test('legacy index-status callbacks and catalog streams preserve their public responses', async () => {
  const service = new MatrixSearchService(settings, { ...dependencies,
    readStatus: async () => ({ ...status, status: 'completed', currentShard: -1, progressPercent: 100, updatedAt: 'now' }),
    readCatalog: async () => ({ databases: [{ list: { name: 'Источник' } }] }),
  })
  const metadata = { get: () => ['reader'] }
  const response = await new Promise((resolve, reject) => service.getIndexStatus({ request: {}, metadata },
    (error, value) => error ? reject(error) : resolve(value)))
  assert.deepEqual(response, { status: 'completed', indexed_shards: 1, total_shards: 1, current_shard: -1, progress_percent: 100, updated_at: 'now' })
  const items = []
  let ended = false
  const call = Object.assign(new EventEmitter(), {
    metadata, request: {},
    write(value) { items.push(value); return true },
    end() { ended = true },
  })
  await service.streamDatabaseAll(call)
  assert.deepEqual(items, [{ name: 'Источник' }])
  assert.equal(ended, true)
})
