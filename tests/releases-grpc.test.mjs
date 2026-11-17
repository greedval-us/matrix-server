import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import grpc from '@grpc/grpc-js'
import { createApplication } from '../node/application.mjs'
import { readSettings } from '../node/config.mjs'
import { loadService } from '../node/core/protos.mjs'
import { publishRelease } from '../node/modules/releases/publish.mjs'

const target = { platform: 'win32', arch: 'x64', kind: 'portable' }
const drain = async source => { const frames = []; for await (const frame of source) frames.push(frame); return frames }

async function fixture(t, { device = false, enabled = true } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'matrix-release-rpc-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'source.exe')
  const content = Buffer.from('verified application')
  await writeFile(file, content)
  const storage = path.join(directory, 'releases')
  const release = await publishRelease({ directory: storage, file, ...target, version: '1.0.1' })
  const logs = []
  const settings = readSettings({
    MATRIX_API_KEY: 'reader', MATRIX_MODULES: enabled ? 'releases' : 'catalog', MATRIX_RELEASES_DIR: storage,
    ...(device ? { MATRIX_AUTH_MODE: 'device', MATRIX_MYSQL_HOST: 'mysql', MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD: 'fixture', MATRIX_GRPC_TLS_CERT: 'test.crt', MATRIX_GRPC_TLS_KEY: 'test.key' } : {}),
  })
  const app = await createApplication(settings, {
    repository: { appendLog: async value => logs.push(value), catalogRows: async () => [] },
    ...(device ? { deviceRepository: { authorize: async () => '42' } } : {}),
  })
  t.after(() => app.close())
  const port = await new Promise((resolve, reject) => app.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)))
  const Client = grpc.makeGenericClientConstructor(loadService('releases.proto', 'matrix.releases.v1.Releases'), 'Releases')
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
  t.after(() => client.close())
  const metadata = key => { const result = new grpc.Metadata(); if (key) result.set('x-api-key', key); return result }
  const latest = (request = target, meta = metadata('reader')) => new Promise((resolve, reject) => client.getLatest(request, meta, { deadline: Date.now() + 3000 }, (error, response) => error ? reject(error) : resolve(response)))
  const download = (request, meta = metadata('reader')) => drain(client.download(request, meta, { deadline: Date.now() + 3000 }))
  return { latest, download, metadata, release, content, logs, client, app }
}

test('real gRPC authorizes both release calls and streams only the selected verified application', async t => {
  const f = await fixture(t)
  const request = { ...target, version: f.release.version, sha256: f.release.sha256 }
  await assert.rejects(f.latest(target, f.metadata('invalid')), { code: grpc.status.UNAUTHENTICATED })
  await assert.rejects(f.download(request, f.metadata()), { code: grpc.status.UNAUTHENTICATED })
  assert.deepEqual(await f.latest(), f.release)
  const frames = await f.download(request)
  assert.deepEqual(frames[0].release, f.release)
  assert.deepEqual(Buffer.concat(frames.slice(1).map(frame => frame.data)), f.content)
  await assert.rejects(f.latest({ ...target, arch: 'arm64' }), { code: grpc.status.NOT_FOUND })
  await assert.rejects(f.download({ ...request, sha256: '0'.repeat(64) }), { code: grpc.status.NOT_FOUND })
  f.client.close(); await f.app.close()
  assert.ok(f.logs.some(log => log.module === 'releases' && log.method === 'Download' && log.statusCode === grpc.status.OK))
  assert.ok(!JSON.stringify(f.logs).includes('reader'))
})

test('disabled release module remains distinguishable from an unpublished target', async t => {
  const f = await fixture(t, { enabled: false })
  await assert.rejects(f.latest(), { code: grpc.status.UNIMPLEMENTED })
})

test('release calls accept device proofs bound to their own method paths and audit identity', async t => {
  const f = await fixture(t, { device: true })
  const identity = generateKeyPairSync('ed25519')
  const apiKey = `mxk_${randomBytes(32).toString('base64url')}`
  function proof(method) {
    const metadata = f.metadata(apiKey)
    const time = String(Date.now())
    const nonce = randomBytes(16).toString('base64url')
    const payload = ['matrix-device-v1', `/matrix.releases.v1.Releases/${method}`, createHash('sha256').update(apiKey).digest('hex'), time, nonce].join('\n')
    metadata.set('x-matrix-device-key', identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'))
    metadata.set('x-matrix-device-time', time)
    metadata.set('x-matrix-device-nonce', nonce)
    metadata.set('x-matrix-device-signature', sign(null, Buffer.from(payload), identity.privateKey).toString('base64url'))
    return metadata
  }
  await assert.rejects(f.latest(target, proof('Download')), { code: grpc.status.UNAUTHENTICATED })
  assert.equal((await f.latest(target, proof('GetLatest'))).version, '1.0.1')
  await f.download({ ...target, version: f.release.version, sha256: f.release.sha256 }, proof('Download'))
  f.client.close(); await f.app.close()
  assert.deepEqual(f.logs.filter(log => log.statusCode === grpc.status.OK).map(log => [log.method, log.accessKeyId]), [['GetLatest', '42'], ['Download', '42']])
})
