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
