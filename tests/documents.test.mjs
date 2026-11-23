import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeDocumentId, parseStoredFields } from '../node/documents.mjs'

test('document id decodes database and source row ids', () => {
  const encoded = (17n << 32n) + 4_294_000_001n
  assert.deepEqual(decodeDocumentId(encoded.toString()), {
    databaseId: 17,
    rowId: '4294000001',
  })
})

test('stored row JSON becomes a protobuf string map without dropping columns', () => {
  assert.deepEqual(
    parseStoredFields('{"id":"42","fio":"Иванов Иван","empty":null,"meta":{"a":1}}'),
    { id: '42', fio: 'Иванов Иван', empty: '', meta: '{"a":1}' },
  )
})

test('imported numeric identifiers retain all digits in flat and nested search results', () => {
  const result = parseStoredFields('{"number":12345678901234567890,"meta":{"id":98765432109876543210}}')
  assert.equal(result.number, '12345678901234567890')
  assert.equal(result.meta, '{"id":98765432109876543210}')
})

test('numeric payloads are rejected as invalid rows', () => {
  assert.throws(() => parseStoredFields('12345678901234567890'), /invalid stored row/)
})
