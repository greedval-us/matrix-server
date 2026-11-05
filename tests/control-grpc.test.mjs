import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'
import { fileURLToPath } from 'node:url'
import { createApplication } from '../node/application.mjs'
import { readSettings } from '../node/config.mjs'

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'matrix-control-grpc-'))
  const rows = new Map(['1', '2'].map(id => [id, { id, values: { id, fio: `Имя ${id}` }, files: [] }]))
  const missing = () => Object.assign(new Error('Record not found'), { code: grpc.status.NOT_FOUND })
  const controlRepository = {
    async get(id) { if (!rows.has(id)) throw missing(); return structuredClone(rows.get(id)) },
    async list() { return { columns: [{ key: 'fio', label: 'ФИО', type: 'text', sortable: true }], rows: [...rows.values()], total: String(rows.size) } },
    async create(values) { const row = { id: '3', values, files: [] }; rows.set('3', row); return row },
    async update(id, values) { const row = await this.get(id); row.values = { ...row.values, ...values }; rows.set(id, row); return row },
    async delete(id) { const row = await this.get(id); if (row.files.length) throw Object.assign(new Error('Remove files first'), { code: 9 }); rows.delete(id); return { deleted: true } },
    async addFiles(id, files) { if (!rows.has(id)) throw missing(); rows.get(id).files.push(...files); return files },
    async getFile(id, fileId) { const row = await this.get(id); const file = row.files.find(file => file.id === fileId); if (!file) throw missing(); return file },
    async removeFile(id, fileId) { const file = await this.getFile(id, fileId); rows.get(id).files = rows.get(id).files.filter(item => item.id !== fileId); return file },
  }
  const settings = readSettings({ MATRIX_API_KEY: 'reader', MATRIX_ADMIN_API_KEY: 'admin', MATRIX_MODULES: 'records', MATRIX_MYSQL_HOST: 'mysql', MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD: 'db', MATRIX_RECORDS_FILE_DIR: directory })
  const app = await createApplication(settings, { repository: { appendLog: async () => {} }, controlRepository })
  const port = await new Promise((resolve, reject) => app.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value)))
  const definition = protoLoader.loadSync(fileURLToPath(new URL('../protos/records.proto', import.meta.url)), { keepCase: true, longs: String, defaults: true, oneofs: true })
  const Type = grpc.loadPackageDefinition(definition).matrix.records.v1.Records
  const client = new Type(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
  const metadata = key => { const result = new grpc.Metadata(); result.set('x-api-key', key); return result }
  const unary = (method, request, key = 'reader') => new Promise((resolve, reject) => client[method](request, metadata(key), { deadline: Date.now() + 5000 }, (error, value) => error ? reject(error) : resolve(value)))
  const upload = frames => new Promise((resolve, reject) => {
    const call = client.uploadFiles(metadata('reader'), { deadline: Date.now() + 5000 }, (error, result) => error ? reject(error) : resolve(result))
    for (const frame of frames) call.write(frame)
    call.end()
  })
  const download = reference => client.downloadFile(reference, metadata('reader'), { deadline: Date.now() + 5000 })
  t.after(async () => { client.close(); await app.close(); await rm(directory, { recursive: true, force: true }) })
  return { unary, upload, download, directory, rows, controlRepository }
}

test('control module advertises and authorizes CRUD for the current client key', async t => {
  const { unary } = await fixture(t)
  assert.equal((await unary('getCapabilities', {})).upload, true)
  const capabilities = await unary('getCapabilities', {})
  assert.equal(capabilities.create, true)
  assert.equal(capabilities.update, true)
  assert.equal(capabilities.delete, true)
  assert.equal((await unary('listRecords', { page: 1, page_size: 25 })).rows[0].values.fio, 'Имя 1')
  await assert.rejects(unary('createRecord', { values: { fio: 'Новая запись' } }, 'invalid'), { code: grpc.status.UNAUTHENTICATED })
  const record = await unary('createRecord', { values: { fio: 'Новая запись' } })
  assert.equal(record.id, '3')
  assert.equal((await unary('updateRecord', { id: '3', values: { note: 'Примечание' } })).values.note, 'Примечание')
  assert.equal((await unary('deleteRecord', { id: '3' })).deleted, true)
})

test('control attachments stream roundtrip and enforce row ownership and confirmed removal', async t => {
  const { unary, upload, download, directory } = await fixture(t)
  const payload = Buffer.from('Содержимое файла\n')
  const { files } = await upload([{ header: { row_id: '1', name: 'документ.txt', size: String(payload.length), mime_type: 'text/plain' } }, { data: payload }])
  assert.equal(files.length, 1)
  assert.equal((await unary('listRecords', {})).rows[0].files[0].name, 'документ.txt')
  const chunks = []
  for await (const chunk of download({ row_id: '1', file_id: files[0].id })) chunks.push(chunk)
  assert.equal(chunks[0].file.id, files[0].id)
  assert.deepEqual(Buffer.concat(chunks.slice(1).map(chunk => chunk.data)), payload)
  await assert.rejects(async () => { for await (const _ of download({ row_id: '2', file_id: files[0].id })) {} }, { code: grpc.status.NOT_FOUND })
  await assert.rejects(unary('deleteRecord', { id: '1' }), { code: grpc.status.FAILED_PRECONDITION })
  assert.equal((await unary('removeFile', { row_id: '1', file_id: files[0].id })).deleted, true)
  assert.equal((await unary('listRecords', {})).rows[0].files.length, 0)
  assert.deepEqual(await readdir(directory), [])
})

test('a failed attachment batch publishes no metadata and cleans owned staged content', async t => {
  const { upload, rows, directory } = await fixture(t)
  await assert.rejects(upload([
    { header: { row_id: '1', name: 'one.txt', size: '1' } }, { data: Buffer.from('a') },
    { header: { row_id: '1', name: 'two.txt', size: '2' } }, { data: Buffer.from('b') },
  ]), { code: grpc.status.INVALID_ARGUMENT })
  assert.equal(rows.get('1').files.length, 0)
  assert.deepEqual(await readdir(directory), [])
})

test('uncertain metadata commit never deletes content already referenced by MySQL', async t => {
  const { upload, download, rows, directory, controlRepository } = await fixture(t)
  controlRepository.addFiles = async (id, files) => {
    rows.get(id).files.push(...files)
    throw Object.assign(new Error('Connection lost after commit'), { code: grpc.status.UNAVAILABLE })
  }
  await assert.rejects(upload([
    { header: { row_id: '1', name: 'committed.txt', size: '1' } }, { data: Buffer.from('a') },
  ]), { code: grpc.status.UNAVAILABLE })
  const file = rows.get('1').files[0]
  assert.equal((await readdir(directory)).length, 1)
  const data = []
  for await (const chunk of download({ row_id: '1', file_id: file.id })) if (chunk.data) data.push(chunk.data)
  assert.equal(Buffer.concat(data).toString(), 'a')
})

test('lost COMMIT response keeps bytes even when a fresh read still sees pre-commit metadata', async t => {
  const { upload, download, rows, directory, controlRepository } = await fixture(t)
  let completeCommit
  controlRepository.addFiles = async (id, files) => {
    completeCommit = () => rows.get(id).files.push(...files)
    throw Object.assign(new Error('COMMIT response lost while server is still committing'), { code: grpc.status.UNAVAILABLE })
  }
  await assert.rejects(upload([
    { header: { row_id: '1', name: 'late-commit.txt', size: '1' } }, { data: Buffer.from('a') },
  ]), { code: grpc.status.UNAVAILABLE })
  assert.equal(rows.get('1').files.length, 0)
  completeCommit()
  assert.equal((await readdir(directory)).length, 1)
  const data = []
  for await (const chunk of download({ row_id: '1', file_id: rows.get('1').files[0].id })) if (chunk.data) data.push(chunk.data)
  assert.equal(Buffer.concat(data).toString(), 'a')
})

test('a proven pre-COMMIT metadata rollback discards staged content instead of leaking rejected batches', async t => {
  const { upload, rows, directory, controlRepository } = await fixture(t)
  controlRepository.addFiles = async () => {
    throw Object.assign(new Error('Attachment cap reached and transaction rolled back'), { code: grpc.status.RESOURCE_EXHAUSTED, metadataRolledBack: true })
  }
  await assert.rejects(upload([
    { header: { row_id: '1', name: 'rejected.txt', size: '1' } }, { data: Buffer.from('a') },
  ]), { code: grpc.status.RESOURCE_EXHAUSTED })
  assert.equal(rows.get('1').files.length, 0)
  assert.deepEqual(await readdir(directory), [])
})
