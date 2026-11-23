import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createWebAdminHandler } from '../node/web-admin/app.mjs'
import { hashPassword, isPasswordHash, verifyPassword } from '../node/web-admin/auth.mjs'
import { createFieldLabelEditor } from '../node/web-admin/field-labels.mjs'

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

async function fixture(t, { repository = {}, catalogEditor, fieldLabelEditor, importCatalog, now } = {}) {
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
    async analytics(from, owner) {
      calls.push(['analytics', from, owner])
      return { keys: { total: 1, bound: 1, pending: 0, revoked: 0, key_digest: 'do not expose' },
        totals: { requests: 3, errors: 1, activeKeys: 1, averageMs: 5, raw_data: 'do not expose' },
        daily: [{ day: '2026-11-11', requests: 3, errors: 1 }],
        topKeys: [{ id: keyId, label: key.label, requests: 3, errors: 1, key_digest: 'do not expose' }] }
    },
    ...repository,
  }
  const server = http.createServer(createWebAdminHandler({ repository: dependencies, catalogEditor, fieldLabelEditor, importCatalog, passwordHash, now }))
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
  assert.deepEqual(calls, [['analytics', '2026-11-05 00:00:00', undefined], ['logPage', {
    id: undefined, from: '2026-11-11 00:00:00', method: 'GetIndexStatus', result: 'error', before: keyId,
  }]])
})

test('analytics accepts an exact owner label only for authenticated and valid requests', async t => {
  const { request, login, calls } = await fixture(t, { now: () => Date.parse('2026-11-11T10:00:00Z') })
  const owner = 'Иванов & Ко + отдел'
  const url = '/api/analytics?' + new URLSearchParams({ days: '1', owner })
  assert.equal((await request(url)).status, 401)
  await login()
  for (const invalid of ['', ' Иванов', 'Иванов ', 'Иванов\u0000', 'а'.repeat(256)]) {
    assert.equal((await request('/api/analytics?' + new URLSearchParams({ owner: invalid }))).status, 400)
  }
  assert.equal((await request(url + '&owner=Другой')).status, 400)
  assert.deepEqual(calls, [])
  const response = await request(url)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).daily.length, 1)
  assert.deepEqual(calls, [['analytics', '2026-11-11 00:00:00', owner]])
})

test('analytics exposes bounded usage metrics without forwarding private fields', async t => {
  const calls = []
  const { request, login } = await fixture(t, {
    now: () => Date.parse('2026-11-11T10:00:00Z'),
    repository: {
      async analytics(from, owner, result) {
        calls.push([from, owner, result])
        return {
          keys: { total: 2, bound: 1, pending: 1, revoked: 0 },
          totals: { requests: 2, errors: 2, activeKeys: 1, averageMs: 11 },
          daily: [{ day: '2026-11-11', requests: 2, errors: 2 }], topKeys: [],
          usage: {
            successes: 0, cancelled: 0, checks: 1, actions: 1, activeOwners: 1, ownerCount: 1, lastActivity: '2026-11-11 09:00:00.123',
            daily: [{ day: '2026-11-11', requests: 2, successes: 0, errors: 2, cancelled: 0, actions: 1, checks: 1 }],
            owners: [{ label: owner, keys: { total: 2, bound: 1, pending: 1, revoked: 0, device_key: 'secret' },
              requests: 2, successes: 0, errors: 2, cancelled: 0, actions: 1, checks: 1, activeKeys: 1,
              averageMs: 11, lastActivity: '2026-11-11 09:00:00.123', key_digest: 'secret',
              search: { requests: 1, withMatches: 0, withoutMatches: 0, unknown: 1, raw_data: 'secret' } }],
            operations: [{ module: 'search', method: 'StreamSearch', requests: 1, successes: 0, errors: 1, cancelled: 0,
              averageMs: 18, p95SuccessMs: null, lastActivity: '2026-11-11 09:00:00.123', background: false, raw_data: 'secret' }],
            errorCodes: [{ code: 14, requests: 2, raw_data: 'secret' }],
            search: { requests: 1, withMatches: 0, withoutMatches: 0, unknown: 1, knownFields: 1,
              averageMs: 18, p95SuccessMs: null, fields: [{ field: 'number', requests: 1, raw_data: 'secret' }], raw_data: 'secret' },
          },
        }
      },
    },
  })
  await login()
  for (const query of ['result=anything', 'result=error&result=all']) {
    assert.equal((await request('/api/analytics?' + query)).status, 400)
  }
  const response = await request('/api/analytics?' + new URLSearchParams({ days: '7', owner: 'Тест', result: 'error' }))
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.doesNotMatch(text, /secret|raw_data|key_digest|device_key/)
  const { usage } = JSON.parse(text)
  assert.equal(usage.activeOwners, 1)
  assert.equal(usage.ownerCount, 1)
  assert.equal(usage.lastActivity, '2026-11-11T09:00:00.123Z')
  assert.deepEqual(usage.daily[0], { day: '2026-11-05', requests: 0, successes: 0, errors: 0, cancelled: 0, actions: 0, checks: 0 })
  assert.equal(usage.owners[0].actions, 1)
  assert.equal(usage.owners[0].keys.total, 2)
  assert.equal(usage.operations[0].p95SuccessMs, null)
  assert.deepEqual(usage.errorCodes, [{ code: 14, requests: 2 }])
  const search = { requests: 1, withMatches: 0, withoutMatches: 0, unknown: 1 }
  assert.deepEqual(usage.owners[0].search, search)
  assert.deepEqual(usage.search, { ...search, knownFields: 1, averageMs: 18, p95SuccessMs: null, fields: [{ field: 'number', requests: 1 }] })
  assert.deepEqual(calls, [['2026-11-05 00:00:00', 'Тест', 'error']])
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

test('catalog list, details and edits require an admin session and same-origin mutations', async t => {
  const calls = []
  const row = { id: '4294967295', name_table: 'source_fixture', name: 'Название', info: null }
  const catalogEditor = {
    async list(options) { calls.push(['list', options]); return { rows: [row], total: 1, page: options.page, pageSize: 50 } },
    async get(id) {
      if (id !== row.id) throw Object.assign(new Error('private details'), { code: 5 })
      calls.push(['get', id]); return row
    },
    async update(id, changes) { calls.push(['update', id, changes]); return { ...row, ...changes } },
  }
  const { request, login } = await fixture(t, { catalogEditor })
  const path = '/api/catalog/' + row.id
  const changes = { name: 'Новое название', info: 'Описание\n'.repeat(700) }
  const update = (body, headers) => request(path, { method: 'POST', body, headers })
  assert.equal((await request('/api/catalog')).status, 401)
  assert.equal((await request(path)).status, 401)
  assert.equal((await update({ changes })).status, 401)
  await login()
  assert.equal((await update({ changes }, { origin: 'https://foreign.example.test' })).status, 403)
  assert.equal((await update(changes)).status, 400)
  assert.equal((await request('/api/catalog?page=0')).status, 400)
  assert.equal((await request('/api/catalog?q=a&q=b')).status, 400)
  assert.equal((await request('/api/catalog/4294967296')).status, 400)
  assert.equal((await request('/api/catalog/1')).status, 404)
  assert.deepEqual(calls, [])

  const list = await request('/api/catalog?' + new URLSearchParams({ q: 'А & Б', page: '2' }))
  assert.deepEqual(await list.json(), { rows: [row], total: 1, page: 2, pageSize: 50 })
  assert.deepEqual(await (await request(path)).json(), { row })
  assert.deepEqual(await (await update({ changes })).json(), { row: { ...row, ...changes } })
  assert.deepEqual(calls, [['list', { query: 'А & Б', page: 2 }], ['get', row.id], ['update', row.id, changes]])
})

test('catalog imports require a session and same origin and stream every selected file', async t => {
  const files = [
    { name: 'first.json', data: '{"mail":"one@example.test"}' },
    { name: 'два.JSON', data: '[{"number":"123456","пометка":"тест"}]' },
  ]
  const metadata = { name: 'Тест' }
  const manifest = { metadata, files: files.map(({ name, data }) => ({ name, size: Buffer.byteLength(data) })) }
  const body = JSON.stringify(manifest) + '\n' + files.map(({ data }) => data).join('')
  const url = '/api/catalog/import'
  const importId = '59659007-53f1-48d2-bd7c-5e4279abcc8a'
  const header = { 'content-type': 'application/octet-stream', 'x-matrix-import-id': importId }
  const seen = []
  const result = { row: { id: '7', name_table: 'generated_table' }, rows: 2, files: 2, newFields: 1 }
  const { login, request } = await fixture(t, {
    async importCatalog(received, uploads, token) {
      assert.deepEqual(received, metadata)
      assert.equal(token, importId)
      for await (const file of uploads) {
        for await (const record of file.records) seen.push([file.name, JSON.parse(record)])
      }
      return result
    },
  })
  const post = (content, headers = header) => request(url, { method: 'POST', body: content, headers })
  assert.equal((await post(body)).status, 401)
  await login()
  assert.equal((await post(body, { ...header, origin: 'https://invalid.example' })).status, 403)
  assert.equal((await request(url)).status, 405)
  assert.equal((await post(body, { ...header, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await post(body, { ...header, 'x-matrix-import-id': 'invalid' })).status, 400)
  assert.equal((await post('invalid')).status, 400)
  assert.deepEqual(seen, [])
  const response = await post(body)
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), result)
  assert.deepEqual(seen, [['first.json', { mail: 'one@example.test' }], ['два.JSON', { number: '123456', пометка: 'тест' }]])
})

test('unconfigured import reports the missing source writer without affecting the catalog', async t => {
  const { request, login } = await fixture(t)
  await login()
  const response = await request('/api/catalog/import', { method: 'POST', body: {} })
  assert.equal(response.status, 503)
  assert.match((await response.json()).error, /импорт/i)
})

test('search field labels are listed and edited by exact key through the authenticated admin API', async t => {
  const row = { field_key: 'Phone_%', label: 'Старое имя' }
  const calls = []
  const fieldLabelEditor = createFieldLabelEditor({
    async execute(sql, parameters) {
      calls.push([sql, parameters])
      if (sql.startsWith('UPDATE')) {
        if (parameters[1] === row.field_key) row.label = parameters[0]
        return {}
      }
      if (sql.startsWith('SELECT COUNT')) return [{ total: '1' }]
      if (sql.includes('WHERE `field_key` = ?') && parameters[0] !== row.field_key) return []
      return [{ ...row, privateValue: 'discard' }]
    },
  })
  const { request, login } = await fixture(t, { fieldLabelEditor })
  const root = '/api/field-labels'
  const edit = root + '/' + encodeURIComponent(row.field_key)
  const save = (path, body, headers) => request(path, { method: 'POST', body, headers })

  assert.equal((await request(root)).status, 401)
  assert.equal((await save(edit, { label: 'Новое имя' })).status, 401)
  await login()
  assert.equal((await save(edit, { label: 'Новое имя' }, { origin: 'https://invalid.example' })).status, 403)
  assert.equal((await save(edit, { label: 'Новое имя', field_key: 'other' })).status, 400)
  assert.equal((await save(edit, { label: ' ' })).status, 400)
  assert.equal((await save(root + '/%zz', { label: 'Имя' })).status, 400)
  assert.equal((await request(root + '?page=0')).status, 400)
  assert.equal((await request(root + '?q=x&q=y')).status, 400)
  assert.equal((await request(edit)).status, 405)
  assert.equal((await request(edit, { method: 'DELETE' })).status, 405)
  assert.equal((await save(root, { label: 'Имя' })).status, 405)
  assert.deepEqual(calls, [])

  const list = await request(root + '?' + new URLSearchParams({ q: '%_', page: '2' }))
  assert.equal(list.status, 200)
  assert.deepEqual(await list.json(), { rows: [row], total: 1, page: 2, pageSize: 50 })
  assert.match(calls[0][0], /LOCATE\(\?, `field_key` COLLATE utf8mb4_0900_as_ci\)/)
  assert.deepEqual(calls[0][1], ['%_', '%_', 50, 50])
  assert.deepEqual(calls[1][1], ['%_', '%_'])

  const missing = await save(root + '/' + encodeURIComponent('phone_%'), { label: 'Иное поле' })
  assert.equal(missing.status, 404)
  assert.equal(row.label, 'Старое имя')
  const updated = await save(edit, { label: ' Новое имя ' })
  assert.equal(updated.status, 200)
  assert.deepEqual(await updated.json(), { row: { field_key: 'Phone_%', label: 'Новое имя' } })
  assert.deepEqual(calls.at(-2), ['UPDATE `search_field_labels` SET `label` = ? WHERE `field_key` = ?', ['Новое имя', 'Phone_%']])
})

test('catalog types are listed and created through the authenticated same-origin admin API', async t => {
  const types = ['Магазины и ритейл']
  const catalogEditor = {
    async listTypes() { return types },
    async createType(name) {
      if (name === 'Магазины') throw Object.assign(new Error('database private details'), { code: 6 })
      types.push(name)
      return name
    },
  }
  const { request, login } = await fixture(t, { catalogEditor })
  const url = '/api/catalog/types'
  const add = (body, headers) => request(url, { method: 'POST', body, headers })
  assert.equal((await request(url)).status, 401)
  assert.equal((await add({ name: 'Name' })).status, 401)
  await login()
  assert.equal((await add({ name: 'Name' }, { origin: 'https://foreign.example.test' })).status, 403)
  assert.equal((await add({ name: 'Name', extra: true })).status, 400)
  assert.equal((await request(url + '?q=x')).status, 400)
  assert.deepEqual(await (await request(url)).json(), { types: ['Магазины и ритейл'] })
  const duplicate = await add({ name: 'Магазины' })
  assert.equal(duplicate.status, 409)
  assert.match((await duplicate.json()).error, /уже/)
  const created = await add({ name: 'Наука' })
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { type: 'Наука' })
  assert.deepEqual(await (await request(url)).json(), { types: ['Магазины и ритейл', 'Наука'] })
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
