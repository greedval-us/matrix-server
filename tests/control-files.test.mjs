import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../node/core/errors.mjs'
import { ControlFileStore } from '../node/modules/records/file-store.mjs'

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'matrix-control-files-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'files')
  return { root, directory, store: new ControlFileStore(directory) }
}

const header = (name = 'report.txt', size = '3', row_id = '12', mime_type = 'text/plain') =>
  ({ header: { row_id, name, size, mime_type } })
const data = (value = 'abc') => ({ data: Buffer.from(value) })
const frames = (items) => Readable.from(items, { objectMode: true })
const failure = (code) => (error) => error instanceof ApplicationError && error.code === code
async function contents(stream) {
  const chunks = []
  for await (const chunk of await stream) chunks.push(chunk)
  return Buffer.concat(chunks)
}

test('stores each complete file under a UUID and returns only publishable metadata', async (t) => {
  const { directory, store } = await fixture(t)
  const metadata = await store.receiveUploads(frames([
    header('C:\\fakepath\\отчёт.txt', '6'), data('abc'), data('def'),
    header('/tmp/empty.txt', '0', '12', ''),
  ]))
  assert.equal(metadata.length, 2)
  assert.match(metadata[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.deepEqual({ ...metadata[0], id: 'generated' }, {
    id: 'generated', name: 'отчёт.txt', size: '6', mime_type: 'text/plain',
  })
  assert.deepEqual({ ...metadata[1], id: 'generated' }, {
    id: 'generated', name: 'empty.txt', size: '0', mime_type: 'application/octet-stream',
  })
  assert.equal((await contents(store.open(metadata[0].id))).toString(), 'abcdef')
  assert.equal((await contents(store.open(metadata[1].id))).length, 0)
  assert.deepEqual((await readdir(directory)).sort(), metadata.map((file) => file.id).sort())
  await store.remove(metadata[0].id)
  await store.remove(metadata[0].id)
  await assert.rejects(store.open(metadata[0].id), failure(grpc.status.NOT_FOUND))
  await store.discard([metadata[1]])
  assert.deepEqual(await readdir(directory), [])
})

test('writes each bounded chunk before requesting the next source frame', async (t) => {
  const { directory, store } = await fixture(t)
  const chunk = Buffer.alloc(65536, 0x61)
  async function* upload() {
    yield header('large.bin', '131073')
    yield { data: chunk }
    const [partial] = await readdir(directory)
    assert.equal((await readFile(path.join(directory, partial))).length, 65536)
    yield { data: chunk }
    assert.equal((await readFile(path.join(directory, partial))).length, 131072)
    yield { data: Buffer.from([0x62]) }
  }
  const [file] = await store.receiveUploads(upload())
  const bytes = await contents(store.open(file.id))
  assert.equal(bytes.length, 131073)
  assert.equal(bytes[65535], 0x61)
  assert.equal(bytes[131072], 0x62)
})

for (const [name, items, options, code] of [
  ['empty batch', [], {}, grpc.status.INVALID_ARGUMENT],
  ['data before a header', [data()], {}, grpc.status.INVALID_ARGUMENT],
  ['missing file bytes', [header()], {}, grpc.status.INVALID_ARGUMENT],
  ['excess file bytes', [header('a.txt', '2'), data()], {}, grpc.status.INVALID_ARGUMENT],
  ['new header before completion', [header(), header('b.txt', '0')], {}, grpc.status.INVALID_ARGUMENT],
  ['mixed rows', [header(), data(), header('b.txt', '0', '13')], {}, grpc.status.INVALID_ARGUMENT],
  ['oversized chunk', [header('a.bin', '65537'), { data: Buffer.alloc(65537) }], {}, grpc.status.RESOURCE_EXHAUSTED],
  ['file byte limit', [header('a.txt', '4')], { maxFileBytes: 3 }, grpc.status.RESOURCE_EXHAUSTED],
  ['batch byte limit', [header(), data(), header('b.txt', '3')], { maxBatchBytes: 5 }, grpc.status.RESOURCE_EXHAUSTED],
  ['file count limit', [header(), data(), header('b.txt', '0')], { maxFiles: 1 }, grpc.status.RESOURCE_EXHAUSTED],
  ['ambiguous frame', [{ ...header(), ...data() }], {}, grpc.status.INVALID_ARGUMENT],
  ['empty frame', [{}], {}, grpc.status.INVALID_ARGUMENT],
  ['nonbinary chunk', [header(), { data: 'abc' }], {}, grpc.status.INVALID_ARGUMENT],
]) {
  test(`rejects ${name} and removes this batch without changing other files`, async (t) => {
    const { directory, store } = await fixture(t)
    await mkdir(directory)
    const existingId = randomUUID()
    await writeFile(path.join(directory, existingId), 'keep')
    await assert.rejects(store.receiveUploads(frames(items), options), failure(code))
    assert.deepEqual(await readdir(directory), [existingId])
    assert.equal(await readFile(path.join(directory, existingId), 'utf8'), 'keep')
  })
}

for (const rowId of ['', '0', '-1', '01', '1.5', '18446744073709551616', '../1']) {
  test(`rejects invalid row ID ${JSON.stringify(rowId)}`, async (t) => {
    const { store } = await fixture(t)
    await assert.rejects(store.receiveUploads(frames([header('a.txt', '0', rowId)])), failure(grpc.status.INVALID_ARGUMENT))
  })
}

for (const size of ['', '-1', '01', '1.5', '18446744073709551616', 3, null]) {
  test(`rejects invalid declared size ${JSON.stringify(size)}`, async (t) => {
    const { store } = await fixture(t)
    await assert.rejects(store.receiveUploads(frames([header('a.txt', size)])), failure(grpc.status.INVALID_ARGUMENT))
  })
}

test('permits the maximum uint64 row ID and Unicode names measured in code points', async (t) => {
  const { store } = await fixture(t)
  const name = `${'😀'.repeat(251)}.txt`
  const [file] = await store.receiveUploads(frames([header(name, '0', '18446744073709551615')]))
  assert.equal(file.name, name)
})

for (const name of ['', '.', '..', '/', 'C:\\', 'report:part.txt', 'a\nb.txt', 'a\u0000.txt', 'a\u0085.txt', 'x'.repeat(256)]) {
  test(`rejects unsafe display name ${JSON.stringify(name)}`, async (t) => {
    const { store } = await fixture(t)
    await assert.rejects(store.receiveUploads(frames([header(name, '0')])), failure(grpc.status.INVALID_ARGUMENT))
  })
}

for (const mime of ['text/plain\r\nInjected: yes', 'not-a-type', 'text/plain; charset=utf-8']) {
  test(`rejects invalid MIME metadata ${JSON.stringify(mime)}`, async (t) => {
    const { store } = await fixture(t)
    await assert.rejects(store.receiveUploads(frames([header('a.txt', '0', '12', mime)])), failure(grpc.status.INVALID_ARGUMENT))
  })
}

test('cleans already finalized files and a partial file after source failure', async (t) => {
  const { directory, store } = await fixture(t)
  async function* upload() {
    yield header()
    yield data()
    yield header('partial.txt')
    yield data('a')
    throw new Error(`sensitive source failure ${directory}`)
  }
  await assert.rejects(store.receiveUploads(upload()), (error) =>
    failure(grpc.status.INTERNAL)(error) && !error.message.includes(directory))
  assert.deepEqual(await readdir(directory), [])
})

test('cancels a pending source read and cleans partial plus completed files', async (t) => {
  const { directory, store } = await fixture(t)
  const controller = new AbortController()
  let sourceClosed = false
  const iterator = {
    [Symbol.asyncIterator]() { return this },
    index: 0,
    async next() {
      const items = [header(), data(), header('partial.txt'), data('a')]
      if (this.index < items.length) return { done: false, value: items[this.index++] }
      controller.abort()
      return new Promise(() => {})
    },
    async return() { sourceClosed = true; return { done: true } },
  }
  await assert.rejects(store.receiveUploads(iterator, { signal: controller.signal }), failure(grpc.status.CANCELLED))
  assert.equal(sourceClosed, true)
  assert.deepEqual(await readdir(directory), [])
})

test('already cancelled uploads do not pull source data', async (t) => {
  const { store } = await fixture(t)
  const controller = new AbortController()
  controller.abort()
  async function* source() { assert.fail('cancelled source must not be read') }
  await assert.rejects(store.receiveUploads(source(), { signal: controller.signal }), failure(grpc.status.CANCELLED))
})

test('filesystem failures are safe application errors', async (t) => {
  const { directory, store } = await fixture(t)
  await writeFile(directory, 'blocks the storage directory')
  await assert.rejects(store.receiveUploads(frames([header(), data()])), (error) =>
    failure(grpc.status.INTERNAL)(error) && !error.message.includes(directory))
  assert.equal(await readFile(directory, 'utf8'), 'blocks the storage directory')
})

test('open, remove and discard reject path-like IDs without touching outside content', async (t) => {
  const { root, store } = await fixture(t)
  const outside = path.join(root, 'outside.txt')
  await writeFile(outside, 'keep')
  for (const id of ['../outside.txt', outside, `${randomUUID()}.part`, 'not-a-uuid']) {
    await assert.rejects(store.open(id), failure(grpc.status.INVALID_ARGUMENT))
    await assert.rejects(store.remove(id), failure(grpc.status.INVALID_ARGUMENT))
    await assert.rejects(store.discard([{ id }]), failure(grpc.status.INVALID_ARGUMENT))
  }
  assert.equal(await readFile(outside, 'utf8'), 'keep')
})

test('refuses symlink content without reading or removing its target', async (t) => {
  const { root, directory, store } = await fixture(t)
  await mkdir(directory)
  const outside = path.join(root, 'outside.txt')
  const fileId = randomUUID()
  await writeFile(outside, 'private')
  try { await symlink(outside, path.join(directory, fileId), 'file') } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('file symlinks need Windows developer mode or privilege')
    throw error
  }
  await assert.rejects(store.open(fileId), failure(grpc.status.FAILED_PRECONDITION))
  await assert.rejects(store.remove(fileId), failure(grpc.status.FAILED_PRECONDITION))
  assert.equal(await readFile(outside, 'utf8'), 'private')
})
