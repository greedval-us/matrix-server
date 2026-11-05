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
