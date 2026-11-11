import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createWebAdminHandler } from '../node/web-admin/app.mjs'
import { hashPassword, isPasswordHash, verifyPassword } from '../node/web-admin/auth.mjs'

const password = 'test-administrator-password'
const passwordHash = await hashPassword(password)
const keyId = '18446744073709551615'
const key = {
  id: keyId,
  label: 'Fixture',
  created_at: '2026-11-11 10:31:54.000',
  activated_at: null,
  revoked_at: null,
}

async function fixture(t, { repository = {}, now } = {}) {
  const calls = []
  const dependencies = {
    async list() { return [{ ...key, apiKey: 'do not expose', key_digest: 'do not expose' }] },
    async issue(label) { calls.push(['issue', label]); return { id: keyId, label, apiKey: 'mxk_fixture', key_digest: 'do not expose' } },
    async revoke(id) { calls.push(['revoke', id]); return { id, revoked: true } },
    async rename(id, label) { calls.push(['rename', id, label]); return { id, label, apiKey: 'do not expose' } },
    async logPage(filters) {
      calls.push(['logPage', filters])
      return { logs: [{ id: '9', access_key_id: keyId, label: key.label, module: 'search', method: 'GetIndexStatus', status_code: 0,
        duration_ms: 5, created_at: '2026-11-11 10:32:00.000', signature: 'do not expose' }], nextCursor: '9' }
    },
    async analytics(from) {
      calls.push(['analytics', from])
      return { keys: { total: 1, bound: 1, pending: 0, revoked: 0, key_digest: 'do not expose' },
        totals: { requests: 3, errors: 1, activeKeys: 1, averageMs: 5, raw_data: 'do not expose' },
        daily: [{ day: '2026-11-11', requests: 3, errors: 1 }],
        topKeys: [{ id: keyId, label: key.label, requests: 3, errors: 1, key_digest: 'do not expose' }] }
    },
    ...repository,
  }
  const server = http.createServer(createWebAdminHandler({ repository: dependencies, passwordHash, now }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const authority = '127.0.0.1:' + server.address().port
  let cookie
  function request(path, { method = 'GET', body, headers = {} } = {}) {
    const mutation = method === 'POST' || method === 'DELETE'
    return fetch('http://' + authority + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(mutation ? { origin: 'https://' + authority, 'x-matrix-admin': '1', 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
  }
  async function login() {
    const response = await request('/api/session', { method: 'POST', body: { password } })
    assert.equal(response.status, 200)
    const setCookie = response.headers.get('set-cookie')
    assert.match(setCookie, /^__Host-matrix-admin=[A-Za-z0-9_-]{43};/)
    for (const flag of [/; Path=\//, /; HttpOnly/, /; Secure/, /; SameSite=Strict/, /; Max-Age=\d+/]) {
      assert.match(setCookie, flag)
    }
    cookie = setCookie.split(';', 1)[0]
    assert.deepEqual(await response.json(), { authenticated: true })
    return setCookie
  }
  return { request, login, calls }
}

test('administrator passwords use a salted scrypt hash and reject malformed hashes', async () => {
  assert.equal(isPasswordHash(passwordHash), true)
  assert.notEqual(await hashPassword(password), passwordHash)
  assert.equal(await verifyPassword(password, passwordHash), true)
  assert.equal(await verifyPassword('wrong password', passwordHash), false)
  assert.equal(await verifyPassword(password, 'scrypt:wrong:wrong'), false)
})

test('authenticated administration exposes only approved metadata and issues a key once', async t => {
  const { request, login, calls } = await fixture(t)
  const unauthenticated = await request('/api/session')
  assert.deepEqual(await unauthenticated.json(), { authenticated: false })
  assert.match(unauthenticated.headers.get('cache-control'), /no-store/)
  assert.match(unauthenticated.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal((await request('/api/keys')).status, 401)
  assert.equal((await request('/api/keys/' + keyId + '/logs')).status, 401)
  assert.equal((await request('/api/keys', { method: 'POST', body: { label: 'Unauthorized' } })).status, 401)
  assert.deepEqual(calls, [])

  await login()
  assert.deepEqual(await (await request('/api/keys')).json(), { keys: [key] })
  const issued = await request('/api/keys', { method: 'POST', body: { label: ' New key ' } })
  assert.equal(issued.status, 201)
  assert.match(issued.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await issued.json(), { id: keyId, label: 'New key', apiKey: 'mxk_fixture' })
  assert.deepEqual(await (await request('/api/keys/' + keyId + '/logs')).json(), {
    nextCursor: '9',
    logs: [{ id: '9', access_key_id: keyId, label: key.label, module: 'search', method: 'GetIndexStatus', status_code: 0,
      duration_ms: 5, created_at: '2026-11-11 10:32:00.000' }],
  })
  assert.deepEqual(await (await request('/api/keys/' + keyId + '/revoke', { method: 'POST', body: {} })).json(),
    { id: keyId, revoked: true })
  assert.deepEqual(calls, [['issue', 'New key'], ['logPage', {
    id: keyId, from: undefined, method: undefined, result: undefined, before: undefined,
  }], ['revoke', keyId]])

  const logout = await request('/api/session', { method: 'DELETE' })
  assert.equal(logout.status, 204)
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
  assert.equal((await request('/api/keys')).status, 401)
})

test('analytics and the global journal require a session and use bounded, validated filters', async t => {
  const { request, login, calls } = await fixture(t, { now: () => Date.parse('2026-11-11T10:00:00Z') })
  assert.equal((await request('/api/analytics')).status, 401)
  assert.equal((await request('/api/logs')).status, 401)
  await login()
  for (const url of ['/api/analytics?days=365', '/api/analytics?days=1&days=7', '/api/logs?before=18446744073709551616',
    '/api/logs?method=some+method', '/api/logs?result=unknown', '/api/logs?days=', '/api/logs?ignored=true']) {
    assert.equal((await request(url)).status, 400, url)
  }
  assert.deepEqual(calls, [])
  const analytics = await (await request('/api/analytics?days=7')).json()
  assert.deepEqual(analytics.keys, { total: 1, bound: 1, pending: 0, revoked: 0 })
  assert.deepEqual(analytics.totals, { requests: 3, errors: 1, activeKeys: 1, averageMs: 5 })
  assert.equal(analytics.daily.length, 7)
  assert.deepEqual(analytics.daily[0], { day: '2026-11-05', requests: 0, errors: 0 })
  assert.deepEqual(analytics.daily.at(-1), { day: '2026-11-11', requests: 3, errors: 1 })
  assert.deepEqual(analytics.topKeys, [{ id: keyId, label: key.label, requests: 3, errors: 1 }])

  const response = await request('/api/logs?days=1&method=GetIndexStatus&result=error&before=' + keyId)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).nextCursor, '9')
  assert.deepEqual(calls, [['analytics', '2026-11-05 00:00:00'], ['logPage', {
    id: undefined, from: '2026-11-11 00:00:00', method: 'GetIndexStatus', result: 'error', before: keyId,
  }]])
})

test('existing keys can be renamed with session and origin checks', async t => {
  const { request, login, calls } = await fixture(t)
  const path = '/api/keys/' + keyId + '/rename'
  const rename = (label, headers) => request(path, { method: 'POST', body: { label }, headers })
  assert.equal((await rename('Name')).status, 401)
  await login()
  assert.equal((await rename('Name', { origin: 'https://foreign.example.test' })).status, 403)
  assert.equal((await rename(' ')).status, 400)
  assert.deepEqual(await (await rename('  Имя сотрудника  ')).json(), { id: keyId, label: 'Имя сотрудника' })
  assert.deepEqual(calls, [['rename', keyId, 'Имя сотрудника']])
})

test('cross-origin, malformed and oversized requests never mutate keys', async t => {
  const { request, login, calls } = await fixture(t)
  assert.equal((await request('/api/session', {
    method: 'POST', body: { password }, headers: { origin: 'https://another.example.test' },
  })).status, 403)
  await login()
  const issue = (body, headers) => request('/api/keys', { method: 'POST', body, headers })
  assert.equal((await issue({ label: 'Foreign origin' }, { origin: 'https://another.example.test' })).status, 403)
  assert.equal((await issue({ label: 'No header' }, { 'x-matrix-admin': '' })).status, 403)
  assert.equal((await issue({ label: 'Wrong type' }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await issue('{')).status, 400)
  assert.equal((await issue({ label: 'x', apiKey: 'injected' })).status, 400)
  assert.equal((await issue({ label: 'x'.repeat(5000) })).status, 413)
  assert.equal((await request('/api/keys/' + keyId + '/revoke', { method: 'POST', body: { ignored: true } })).status, 400)
  assert.equal((await request('/api/keys/18446744073709551616/logs')).status, 400)
  assert.equal((await request('/%2e%2e%2fpackage.json')).status, 404)
  assert.deepEqual(calls, [])
})

test('sessions expire and failed login attempts are throttled until the window ends', async t => {
  let clock = Date.parse('2026-11-11T10:00:00Z')
  const { request, login } = await fixture(t, { now: () => clock })
  const setCookie = await login()
  const [, cookieSeconds] = /Max-Age=(\d+)/.exec(setCookie)
  clock += Number(cookieSeconds) * 1000 + 1
  assert.equal((await request('/api/keys')).status, 401)
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request('/api/session', { method: 'POST', body: { password: 'wrong password' } })
    assert.equal(response.status, 401)
  }
  const throttled = await request('/api/session', { method: 'POST', body: { password } })
  assert.equal(throttled.status, 429)
  clock += Number(throttled.headers.get('retry-after')) * 1000 + 1
  await login()
})

test('database errors return a safe message', async t => {
  const { request, login } = await fixture(t, {
    repository: { async list() { throw Object.assign(new Error('password and SQL details'), { code: 14 }) } },
  })
  await login()
  const response = await request('/api/keys')
  assert.equal(response.status, 503)
  const body = await response.json()
  assert.equal(typeof body.error, 'string')
  assert.doesNotMatch(body.error, /password|SQL/)
})
