import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import { DeviceAccessRepository } from '../node/infrastructure/mysql/device-access.mjs'
import { OperationalRepository } from '../node/infrastructure/mysql/repository.mjs'

const claim = {
  keyDigest: randomBytes(32), deviceKey: randomBytes(44), nonce: randomBytes(16),
  now: 1_800_000_000_000, expiresAt: 1_800_000_120_000,
}

function poolWithResponses(responses) {
  const actions = []
  const connection = {
    beginTransaction: async () => actions.push('begin'),
    execute: async (sql, params) => {
      actions.push({ sql, params })
      const response = responses.shift()
      if (response instanceof Error) throw response
      return [response]
    },
    commit: async () => actions.push('commit'),
    rollback: async () => actions.push('rollback'),
    release: () => actions.push('release'),
  }
  const pool = { getConnection: async () => connection, execute: connection.execute }
  return { actions, pool }
}

test('claim locks an unrevoked key and commits its nonce and first device together', async () => {
  const { actions, pool } = poolWithResponses([[{ id: '12', device_key: null }], {}, {}, {}, {}])
  const repository = new DeviceAccessRepository(pool, { now: () => claim.now })
  assert.equal(await repository.authorize(claim), '12')
  assert.equal(actions[0], 'begin')
  assert.match(actions[1].sql, /WHERE `key_digest` = \? AND `revoked_at` IS NULL FOR UPDATE/)
  assert.deepEqual(actions[1].params, [claim.keyDigest])
  assert.match(actions[2].sql, /INSERT INTO `access_key_nonces`/)
  assert.deepEqual(actions[2].params, ['12', claim.nonce, claim.expiresAt])
  assert.match(actions[3].sql, /SET `device_key` = \?, `activated_at` = CURRENT_TIMESTAMP\(3\)/)
  assert.deepEqual(actions[3].params, [claim.deviceKey, '12'])
  assert.ok(actions.indexOf('commit') < actions.indexOf('release'))
})

test('a different key is forbidden and rolls back without updating the binding', async () => {
  const { actions, pool } = poolWithResponses([[{ id: '12', device_key: randomBytes(44) }]])
  await assert.rejects(new DeviceAccessRepository(pool, { now: () => claim.now }).authorize(claim), { code: 7, message: 'API key is already bound to another device' })
  assert.deepEqual(actions.slice(-2), ['rollback', 'release'])
  assert.ok(!actions.some(action => action.sql?.startsWith('UPDATE')))
})

test('a replay and an absent or revoked key roll back without updating the binding', async () => {
  const duplicate = Object.assign(new Error('secret database detail'), { code: 'ER_DUP_ENTRY' })
  for (const responses of [[[{ id: '12', device_key: claim.deviceKey }], duplicate], [[]]]) {
    const { actions, pool } = poolWithResponses(responses)
    assert.equal(await new DeviceAccessRepository(pool, { now: () => claim.now }).authorize(claim), null)
    assert.deepEqual(actions.slice(-2), ['rollback', 'release'])
    assert.ok(!actions.some(action => action.sql?.startsWith('UPDATE')))
  }
})

test('issue stores only a digest and returns the raw key to the administrator once', async () => {
  const { actions, pool } = poolWithResponses([{ insertId: 17 }])
  const issued = await new DeviceAccessRepository(pool).issue('Operator')
  assert.equal(issued.id, '17')
  assert.match(issued.apiKey, /^mxk_[A-Za-z0-9_-]{43}$/)
  assert.deepEqual(actions[0].params, ['Operator', createHash('sha256').update(issued.apiKey).digest()])
})

test('audit stores key ID and operation metadata without the key, proof or request body', async () => {
  const { actions, pool } = poolWithResponses([{}])
  await new OperationalRepository(pool).appendLog({
    accessKeyId: '12', module: 'search', method: 'GetIndexStatus', statusCode: 0, durationMs: 4,
    apiKey: 'secret key', signature: 'secret proof', request: 'private search',
  })
  assert.match(actions[0].sql, /INSERT INTO `access_key_logs`/)
  assert.deepEqual(actions[0].params, ['12', 'search', 'GetIndexStatus', 0, 4])
})

test('a proof that expires while waiting for the row lock cannot authorize', async () => {
  const { actions, pool } = poolWithResponses([[{ id: '12', device_key: claim.deviceKey }]])
  const repository = new DeviceAccessRepository(pool, { now: () => claim.expiresAt + 1 })
  assert.equal(await repository.authorize(claim), null)
  assert.deepEqual(actions.slice(-2), ['rollback', 'release'])
  assert.ok(!actions.some(action => action.sql?.startsWith('INSERT')))
})
