import assert from 'node:assert/strict'
import test from 'node:test'

import { ManticoreClient } from '../node/manticore.mjs'

test('Manticore scroll yields every result page without a global result limit', async () => {
  const requests = []
  const responses = [
    {
      hits: { total: 3, hits: [{ _id: 1 }, { _id: 2 }] },
      took: 4,
      scroll: 'next-page',
    },
    {
      hits: { total: 1, hits: [{ _id: 3 }] },
      took: 2,
      scroll: 'finished',
    },
  ]
  const client = new ManticoreClient({
    baseUrl: 'http://manticore.test',
    table: 'matrix_records',
    maxQueryTimeMs: 5000,
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body))
      const body = responses.shift()
      return { ok: true, text: async () => JSON.stringify(body) }
    },
  })

  const pages = []
  for await (const page of client.searchAll('(@number "70000000000")', 2)) {
    pages.push(page)
  }

  assert.deepEqual(pages.map((page) => page.hits.map((hit) => hit._id)), [[1, 2], [3]])
  assert.equal(requests[0].options.scroll, true)
  assert.deepEqual(requests[0]._source, ['payload'])
  assert.deepEqual(requests[0].sort, [{ id: { order: 'asc' } }])
  assert.equal(requests[1].options.scroll, 'next-page')
  assert.equal(requests[1].sort, undefined)
})

test('ordinary search cannot substantiate audit coverage for partial or malformed engine responses', async () => {
  const hits = { total: 0, total_relation: 'eq', hits: [] }
  const replies = [
    [{ hits }, true],
    [{ timed_out: true, hits }, false],
    [{ warning: { reason: 'query time exceeded' }, hits }, false],
    [{ hits: { ...hits, total_relation: 'gte' } }, false],
    [{ hits: { ...hits, total: {} } }, false],
    [{ hits: { ...hits, total: undefined } }, false],
    [{ hits: { ...hits, hits: undefined } }, false],
  ]
  for (const [body, complete] of replies) {
    const client = new ManticoreClient({
      baseUrl: 'http://manticore.test', table: 'test', maxQueryTimeMs: 5000,
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(body) }),
    })
    const pages = []
    for await (const page of client.searchAll('(@number "70000000000")', 2)) pages.push(page)
    assert.equal(pages.length, 1)
    assert.deepEqual(pages[0].hits, [])
    assert.equal(pages[0].complete, complete)
  }
})

test('broad search matches IDs before reading payloads and traverses every shard', async () => {
  const requests = []
  const replies = [
    '{"hits":{"total":3,"total_relation":"eq","hits":[{"_id":9007199254740993},{"_id":9007199254740995},{"_id":9007199254740998}]},"took":21}',
    '{"hits":{"total":2,"total_relation":"eq","hits":[{"_id":9007199254740993,"_source":{"payload":"a"}},{"_id":9007199254740995,"_source":{"payload":"b"}}]},"took":3}',
    '{"hits":{"total":1,"total_relation":"eq","hits":[{"_id":9007199254740998,"_source":{"payload":"c"}}]},"took":4}',
    '{"hits":{"total":0,"total_relation":"eq","hits":[]},"took":5}',
  ]
  const client = new ManticoreClient({
    baseUrl: 'http://manticore.test', table: 'matrix_records', maxQueryTimeMs: 5000,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'http://manticore.test/sql')
      requests.push(options.body)
      return { ok: true, text: async () => replies.shift() }
    },
  })
  const pages = []
  for await (const page of client.searchBroad('(@number "7978*")', 2, { tables: ['matrix_row_0001', 'matrix_row_0002'] })) pages.push(page)
  assert.deepEqual(pages.flatMap(page => page.hits.map(hit => hit._source.payload)), ['a', 'b', 'c'])
  assert.equal(pages.reduce((total, page) => total + page.tookMs, 0), 33)
  assert.match(requests[0], /SELECT id FROM matrix_row_0001 WHERE MATCH/)
  assert.match(requests[1], /SELECT id, payload FROM matrix_row_0001 WHERE id IN \(9007199254740993,9007199254740995\)/)
  assert.match(requests[2], /id IN \(9007199254740998\)/)
  assert.match(requests[3], /SELECT id FROM matrix_row_0002 WHERE MATCH/)
})

test('broad search refuses incomplete engine results', async () => {
  const client = new ManticoreClient({
    baseUrl: 'http://manticore.test', table: 'matrix_records', maxQueryTimeMs: 5000,
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({
      warning: { reason: 'query time exceeded' },
      hits: { total: 0, total_relation: 'eq', hits: [] },
    }) }),
  })
  const iterator = client.searchBroad('(@number "7978*")', 2, { tables: ['matrix_row_0001'] })
  await assert.rejects(iterator.next(), /incomplete/i)
})

test('broad search stops before reading more payload after cancellation', async () => {
  const controller = new AbortController()
  let requests = 0
  const client = new ManticoreClient({
    baseUrl: 'http://manticore.test', table: 'matrix_records', maxQueryTimeMs: 5000,
    fetchImpl: async () => {
      requests += 1
      return { ok: true, text: async () => JSON.stringify({
        hits: { total: 1, total_relation: 'eq', hits: [{ _id: 1 }] },
      }) }
    },
  })
  const iterator = client.searchBroad('(@number "7978*")', 2, {
    tables: ['matrix_row_0001'], signal: controller.signal,
  })
  await iterator.next()
  controller.abort()
  assert.equal((await iterator.next()).done, true)
  assert.equal(requests, 1)
})
