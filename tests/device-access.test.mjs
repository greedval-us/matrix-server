import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import grpc from '@grpc/grpc-js'
import { createApplication } from '../node/application.mjs'
import { createAuthorizer } from '../node/core/auth.mjs'
import { loadService } from '../node/core/protos.mjs'
import { createRpcHandlers } from '../node/core/rpc.mjs'
import { readSettings } from '../node/config.mjs'
import { DeviceAccessRepository } from '../node/infrastructure/mysql/device-access.mjs'

const rpcPath = '/base_search.BaseSearches/GetIndexStatus'
const clock = 1_800_000_000_000
const apiKey = `mxk_${randomBytes(32).toString('base64url')}`

function signedCall(identity, { path = rpcPath, time = String(clock), nonce = randomBytes(16).toString('base64url') } = {}) {
  const digest = createHash('sha256').update(apiKey).digest('hex')
  const payload = Buffer.from(['matrix-device-v1', path, digest, time, nonce].join('\n'))
  const metadata = new grpc.Metadata()
  metadata.set('x-api-key', apiKey)
  metadata.set('x-matrix-device-key', identity.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'))
  metadata.set('x-matrix-device-time', time)
  metadata.set('x-matrix-device-nonce', nonce)
  metadata.set('x-matrix-device-signature', sign(null, payload, identity.privateKey).toString('base64url'))
  return { metadata, getPath: () => path }
}

const authRejected = { code: grpc.status.UNAUTHENTICATED }

test('device mode requires TLS and MySQL but does not require a shared user key', () => {
  const environment = { MATRIX_AUTH_MODE: 'device', MATRIX_GRPC_TLS_CERT: 'server.crt', MATRIX_GRPC_TLS_KEY: 'server.key' }
  assert.throws(() => readSettings(environment), /MySQL/)
  const mysql = { MATRIX_MYSQL_HOST: 'mysql', MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD: 'example' }
  assert.throws(() => readSettings({ ...mysql, MATRIX_AUTH_MODE: 'device' }), /TLS/)
  assert.equal(readSettings({ ...environment, ...mysql }).authMode, 'device')
  assert.throws(() => readSettings({ MATRIX_AUTH_MODE: 'unknown', MATRIX_API_KEY: 'reader' }), /MATRIX_AUTH_MODE/)
})

test('valid Ed25519 metadata identifies the key and passes canonical bytes and expiry to storage', async () => {
  const identity = generateKeyPairSync('ed25519')
  const nonce = randomBytes(16).toString('base64url')
  const authorize = createAuthorizer({ authMode: 'device', apiKey: 'legacy', adminApiKey: 'admin' }, {
    now: () => clock,
    deviceRepository: { authorize: async claim => {
      assert.deepEqual(claim.keyDigest, createHash('sha256').update(apiKey).digest())
      assert.deepEqual(claim.deviceKey, identity.publicKey.export({ format: 'der', type: 'spki' }))
      assert.deepEqual(claim.nonce, Buffer.from(nonce, 'base64url'))
      assert.equal(claim.now, clock)
      assert.equal(claim.expiresAt, clock + 120_000)
      return '12'
    } },
  })
  assert.deepEqual(await authorize(signedCall(identity, { nonce })), { accessKeyId: '12' })
})

test('device mode rejects legacy, expired, altered-method and ambiguous proofs before storage', async () => {
  const identity = generateKeyPairSync('ed25519')
  let claims = 0
  const authorize = createAuthorizer({ authMode: 'device', apiKey: 'legacy', adminApiKey: 'admin' }, {
    now: () => clock,
    deviceRepository: { authorize: async () => { claims++; return '12' } },
  })
  const shared = new grpc.Metadata(); shared.set('x-api-key', 'legacy')
  await assert.rejects(authorize({ metadata: shared }), authRejected)
  await assert.rejects(authorize(signedCall(identity, { time: String(clock - 120_001) })), authRejected)
  const call = signedCall(identity)
  await assert.rejects(authorize({ ...call, getPath: () => '/base_search.BaseSearches/StreamSearch' }), authRejected)
  call.metadata.add('x-matrix-device-time', String(clock))
  await assert.rejects(authorize(call), authRejected)
  assert.equal(claims, 0)

  const admin = new grpc.Metadata(); admin.set('x-api-key', 'admin')
  assert.equal(await authorize({ metadata: admin }, 'admin'), undefined)
  await assert.rejects(authorize({ metadata: admin }), authRejected)
})

test('a revoked, already-bound or replayed key rejected by storage is unauthenticated', async () => {
  const authorize = createAuthorizer({ authMode: 'device' }, {
    now: () => clock,
    deviceRepository: { authorize: async () => null },
  })
  await assert.rejects(authorize(signedCall(generateKeyPairSync('ed25519'))), authRejected)
})

test('a verified attempt from a different device is attributed to the key without exposing its ID', async () => {
  const identity = generateKeyPairSync('ed25519')
  const boundKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' })
  const logs = []
  const connection = {
    beginTransaction: async () => {},
    execute: async () => [[{ id: '12', device_key: boundKey }]],
    rollback: async () => {},
    release: () => {},
  }
  const deviceRepository = new DeviceAccessRepository({ getConnection: async () => connection }, { now: () => clock })
  const authorize = createAuthorizer({ authMode: 'device' }, { deviceRepository, now: () => clock })
  const handlers = createRpcHandlers({ authorize, audit: { record: log => logs.push(log) } })
  const unexpectedHandler = () => assert.fail('denied request reached the handler')
  const checkError = error => {
    assert.equal(error.code, grpc.status.PERMISSION_DENIED)
    assert.equal(error.message, 'API key is already bound to another device')
    assert.equal('accessKeyId' in error, false)
  }

  await handlers.unary('search', 'GetIndexStatus', unexpectedHandler)(signedCall(identity), checkError)
  const stream = Object.assign(new EventEmitter(), signedCall(identity, { path: '/base_search.BaseSearches/StreamSearch' }))
  stream.on('error', checkError)
  await handlers.stream('search', 'StreamSearch', unexpectedHandler)(stream)

  assert.deepEqual(logs.map(({ method, statusCode, accessKeyId }) => ({ method, statusCode, accessKeyId })), [
    { method: 'GetIndexStatus', statusCode: grpc.status.PERMISSION_DENIED, accessKeyId: '12' },
    { method: 'StreamSearch', statusCode: grpc.status.PERMISSION_DENIED, accessKeyId: '12' },
  ])
  assert.ok(!JSON.stringify(logs).includes(apiKey))
})

test('registered gRPC search uses the device identity for its audit entry', async t => {
  const logs = []
  const settings = readSettings({
    MATRIX_AUTH_MODE: 'device', MATRIX_MODULES: 'search',
    MATRIX_MYSQL_HOST: 'mysql', MATRIX_MYSQL_USER: 'matrix', MATRIX_MYSQL_PASSWORD: 'example',
    MATRIX_GRPC_TLS_CERT: 'server.crt', MATRIX_GRPC_TLS_KEY: 'server.key',
  })
  const app = await createApplication(settings, {
    repository: { appendLog: async value => logs.push(value) },
    deviceRepository: { authorize: async () => '12' },
  })
  t.after(() => app.close())
  const port = await new Promise((resolve, reject) => {
    app.server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, value) => error ? reject(error) : resolve(value))
  })
  const Client = grpc.makeGenericClientConstructor(loadService('base_search.proto', 'base_search.BaseSearches'), 'BaseSearches')
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure())
  t.after(() => client.close())
  const identity = generateKeyPairSync('ed25519')
  const metadata = signedCall(identity, { time: String(Date.now()) }).metadata
  const status = await new Promise((resolve, reject) => {
    client.getIndexStatus({}, metadata, { deadline: Date.now() + 3000 }, (error, value) => error ? reject(error) : resolve(value))
  })
  assert.equal(status.status, 'not_started')
  client.close()
  await app.close()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].module, 'search')
  assert.equal(logs[0].method, 'GetIndexStatus')
  assert.equal(logs[0].statusCode, grpc.status.OK)
  assert.equal(logs[0].accessKeyId, '12')
  assert.ok(!JSON.stringify(logs).includes(apiKey))
})

test('a cancelled unary request is not executed after delayed device authorization', async () => {
  let resolveAuthorization
  const authorization = new Promise(resolve => { resolveAuthorization = resolve })
  const logs = []
  const handlers = createRpcHandlers({ authorize: () => authorization, audit: { record: log => logs.push(log) } })
  const handler = handlers.unary('records', 'DeleteRecord', () => assert.fail('cancelled request reached the handler'))
  const call = { cancelled: false, request: { id: '1' } }
  let responded = false
  const pending = handler(call, () => { responded = true })
  call.cancelled = true
  resolveAuthorization({ accessKeyId: '12' })
  await pending
  assert.equal(responded, false)
  assert.equal(logs[0].statusCode, grpc.status.CANCELLED)
  assert.equal(logs[0].accessKeyId, '12')
})
