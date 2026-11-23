import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { CatalogUploadError, readImportUpload } from '../node/web-admin/import-upload.mjs'

const metadata = { name: 'Проверочная база' }

function request(chunks, headers = {}) {
  const stream = Readable.from(chunks)
  stream.headers = { 'content-type': 'application/octet-stream', ...headers }
  return stream
}

function header(files) {
  return Buffer.from(JSON.stringify({ metadata, files }) + '\n')
}

function upload(documents, chunkSize, trailer = '') {
  const files = documents.map(([name, body]) => ({ name, size: Buffer.byteLength(body) }))
  const body = Buffer.concat([header(files), ...documents.map(([, body]) => Buffer.from(body)), Buffer.from(trailer)])
  function* chunks() {
    for (let i = 0; i < body.length; i += chunkSize) yield body.subarray(i, i + chunkSize)
  }
  return request(chunks())
}

async function consume(stream) {
  const { metadata: received, files } = await readImportUpload(stream)
  const data = []
  for await (const file of files) data.push([file.name, await Array.fromAsync(file.records)])
  return { received, data }
}

test('streams single records and arrays across arbitrary UTF-8, escape, header and file boundaries', async () => {
  const first = JSON.stringify({ mail: 'ёж@example.test', nested: [null, { note: '"}\\[]' }] })
  const second = '{"number": 9223372036854775807}'
  const documents = [['чужой.JSON', '\uFEFF \r\n' + first], ['group.json', '[ ' + first + ',\n' + second + ' ]\t']]
  const expected = { received: metadata, data: [['чужой.JSON', [first]], ['group.json', [first, second]]] }
  for (const size of [1, 2, 7, 31, 65536]) assert.deepEqual(await consume(upload(documents, size)), expected)
})

test('emits a completed record before pulling the rest of its file', async () => {
  let resumed = false
  async function* parts() {
    yield Buffer.concat([header([{ name: 'part.json', size: 9 }]), Buffer.from('[{},')])
    resumed = true
    yield Buffer.from(' {} ]')
  }
  const { files } = await readImportUpload({ headers: { 'content-type': 'application/octet-stream' }, iterator: parts })
  const { value: file } = await files.next()
  const { value } = await file.records.next()
  assert.equal(value, '{}')
  assert.equal(resumed, false)
  assert.deepEqual(await Array.fromAsync(file.records), ['{}'])
  assert.equal((await files.next()).done, true)
  assert.equal(resumed, true)
})

test('rejects invalid or empty records in a later file, identifying it by name', async () => {
  for (const invalid of ['', '[]', '[{},]', '{}{}', '[{}, 1]', 'null', ' [{"x":1}', '{x:1}', '[[]]']) {
    await assert.rejects(consume(upload([['ok.json', '{}'], ['bad.json', invalid]], 2)), error => {
      return error instanceof CatalogUploadError && error.status === 400 && error.message.includes('bad.json')
    })
  }
})

test('rejects malformed UTF-8, overnested data, and oversize records without echoing their values', async () => {
  const name = 'input.json'
  const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc0, 0x22, 0x7d])
  await assert.rejects(consume(request([header([{ name, size: bytes.length }]), bytes])), { status: 400 })
  const deep = '{"x":' + '['.repeat(100) + '1' + ']'.repeat(100) + '}'
  await assert.rejects(consume(upload([[name, deep]], 13)), CatalogUploadError)
  const huge = '{"x":"' + 'a'.repeat(4 * 1024 * 1024) + '"}'
  await assert.rejects(consume(upload([[name, huge]], 32 * 1024)), { status: 413 })
})

test('rejects extra bytes, truncated files, invalid headers and unsupported media types', async () => {
  await assert.rejects(consume(upload([['f.json', '{}']], 4, 'x')), { status: 400 })
  await assert.rejects(consume(request([header([{ name: 'short.json', size: 3 }]), Buffer.from('{}')])), /short\.json/)
  for (const files of [[], [{ name: '../x.json', size: 2 }], [{ name: 'x.txt', size: 2 }], [{ name: 'x.json', size: -1 }]]) {
    await assert.rejects(consume(request([header(files)])), { status: 400 })
  }
  await assert.rejects(consume(request([Buffer.from('{}')])), { status: 400 })
  await assert.rejects(consume(request([Buffer.alloc(1024 * 1024 + 1, 32)])), { status: 413 })
  await assert.rejects(consume(request([header([{ name: 'big.json', size: (64 * 1024 ** 3) + 1 }])])), { status: 413 })
  await assert.rejects(consume(request([], { 'content-type': 'application/json' })), { status: 415 })
})
