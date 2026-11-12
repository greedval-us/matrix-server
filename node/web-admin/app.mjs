import { readFile } from 'node:fs/promises'
import { createLoginLimiter, createSessions, isPasswordHash, isValidPassword, verifyPassword } from './auth.mjs'

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/admin.css', ['admin.css', 'text/css; charset=utf-8']],
  ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']],
])
const headers = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
}
const maxBody = 4096
const maxCatalogBody = 400 * 1024
const maxKeyId = 18_446_744_073_709_551_615n
const allowedPeriods = new Set(['1', '7', '30'])
const logResults = new Set(['success', 'error', 'cancelled'])
const dayMs = 86_400_000

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function invalidBody() {
  return new HttpError(400, 'Некорректные данные запроса.')
}

function invalidFilter() {
  return new HttpError(400, 'Некорректные фильтры.')
}

function json(response, status, data) {
  const body = Buffer.from(JSON.stringify(data))
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length })
  response.end(body)
}

function validOrigin(request) {
  const { host, origin, 'x-matrix-admin': adminHeader } = request.headers
  if (adminHeader !== '1' || !host || !/^[A-Za-z0-9._:\-\[\]]+$/.test(host)) return false
  try { return origin === new URL('https://' + host).origin }
  catch { return false }
}

async function readJson(request, property, limit = maxBody) {
  const mime = (request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
  if (mime !== 'application/json') throw new HttpError(415, 'Отправьте запрос в формате JSON.')
  const tooLarge = () => new HttpError(413, 'Запрос слишком большой.')
  if (Number(request.headers['content-length']) > limit) throw tooLarge()
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) throw tooLarge()
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')) }
  catch { throw invalidBody() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidBody()
  const keys = Object.keys(value)
  if (property === undefined ? keys.length !== 0 : keys.length !== 1 || keys[0] !== property) throw invalidBody()
  return value
}

function normalizeLabel(value) {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!label || label.length > 255 || /[\u0000-\u001f\u007f]/.test(label)) return null
  return label
}

async function readLabel(request) {
  const input = await readJson(request, 'label')
  const label = normalizeLabel(input.label)
  if (label === null) throw invalidBody()
  return label
}

function readFilters(query, allowed) {
  const filters = Object.create(null)
  for (const [name, value] of new URLSearchParams(query)) {
    if (!allowed.includes(name) || Object.hasOwn(filters, name)) throw invalidFilter()
    filters[name] = value
  }
  return filters
}

function utcDay(time, offset) {
  return new Date(time - offset * dayMs).toISOString().slice(0, 10)
}

function periodStart(time, days) {
  return `${utcDay(time, days - 1)} 00:00:00`
}

function keyMetadata({ id, label, created_at, activated_at, revoked_at }) {
  return { id: String(id), label, created_at, activated_at, revoked_at }
}

function logMetadata({ id, access_key_id, label, module, method, status_code, duration_ms, created_at }) {
  return { id: String(id), access_key_id: String(access_key_id), label, module, method, status_code, duration_ms, created_at }
}

function publicError(error) {
  if (error instanceof HttpError) return error
  if (error?.code === 3) return invalidBody()
  if (error?.code === 5) return new HttpError(404, 'Запись каталога не найдена.')
  if (error?.code === 14) return new HttpError(503, 'База данных временно недоступна.')
  return new HttpError(500, 'Не удалось выполнить запрос.')
}

export function createWebAdminHandler({ repository, catalogEditor, passwordHash, now = Date.now }) {
  if (!isPasswordHash(passwordHash)) throw new Error('Invalid web admin password hash')
  const sessions = createSessions(now)
  const reserveLogin = createLoginLimiter(now)

  async function session(request, response) {
    const cookie = request.headers.cookie
    if (request.method === 'GET') return json(response, 200, { authenticated: sessions.authenticated(cookie) })
    if (request.method === 'DELETE') {
      response.writeHead(204, { 'Set-Cookie': sessions.end(cookie) })
      return response.end()
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Метод запроса недоступен.')
    const { password } = await readJson(request, 'password')
    if (!isValidPassword(password)) throw invalidBody()
    const attempt = reserveLogin(request.socket.remoteAddress || '')
    if (attempt.retryAfter) {
      response.setHeader('Retry-After', attempt.retryAfter)
      throw new HttpError(429, 'Слишком много попыток входа. Попробуйте позже.')
    }
    let accepted = false
    try { accepted = await verifyPassword(password, passwordHash) }
    finally { attempt.finish(accepted) }
    if (!accepted) throw new HttpError(401, 'Неверный пароль.')
    response.setHeader('Set-Cookie', sessions.start(cookie))
    return json(response, 200, { authenticated: true })
  }

  async function analytics(response, query) {
    const { days = '7', owner } = readFilters(query, ['days', 'owner'])
    if (!allowedPeriods.has(days)) throw invalidFilter()
    if (owner !== undefined && normalizeLabel(owner) !== owner) throw invalidFilter()
    const dayCount = Number(days)
    const time = now()
    const { keys, totals, daily, topKeys } = await repository.analytics(periodStart(time, dayCount), owner)
    const { total, bound, pending, revoked } = keys
    const { requests, errors, activeKeys, averageMs } = totals
    const byDay = new Map(daily.map(row => [row.day, row]))
    return json(response, 200, {
      keys: { total, bound, pending, revoked },
      totals: { requests, errors, activeKeys, averageMs },
      daily: Array.from({ length: dayCount }, (_, index) => {
        const day = utcDay(time, dayCount - index - 1)
        const { requests = 0, errors = 0 } = byDay.get(day) ?? {}
        return { day, requests, errors }
      }),
      topKeys: topKeys.map(({ id, label, requests, errors }) => ({ id: String(id), label, requests, errors })),
    })
  }

  async function logPage(response, query, id) {
    const { days = '0', method, result, before } = readFilters(query, ['days', 'method', 'result', 'before'])
    if (days !== '0' && !allowedPeriods.has(days)) throw invalidFilter()
    if (method !== undefined && !/^[A-Za-z0-9_./]{1,128}$/.test(method)) throw invalidFilter()
    if (result !== undefined && !logResults.has(result)) throw invalidFilter()
    if (before !== undefined && (!/^[1-9][0-9]{0,19}$/.test(before) || BigInt(before) > maxKeyId)) throw invalidFilter()
    const from = days === '0' ? undefined : periodStart(now(), Number(days))
    const page = await repository.logPage({ id, from, method, result, before })
    return json(response, 200, { logs: page.logs.map(logMetadata), nextCursor: page.nextCursor })
  }

  async function catalog(request, response, path, query) {
    const { method } = request
    if (path === '/api/catalog/types') {
      readFilters(query, [])
      if (method === 'GET') return json(response, 200, { types: await catalogEditor.listTypes() })
      if (method === 'POST') {
        const { name } = await readJson(request, 'name')
        try {
          return json(response, 201, { type: await catalogEditor.createType(name) })
        } catch (error) {
          if (error?.code === 6) throw new HttpError(409, 'Такое название уже есть в справочнике. Выберите существующий тип.')
          throw error
        }
      }
      throw new HttpError(405, 'Метод запроса недоступен.')
    }
    if (path === '/api/catalog' && method === 'GET') {
      const { q = '', page = '1' } = readFilters(query, ['q', 'page'])
      if (!/^[1-9][0-9]{0,8}$/.test(page)) throw invalidFilter()
      return json(response, 200, await catalogEditor.list({ query: q, page: Number(page) }))
    }
    const match = /^\/api\/catalog\/([1-9][0-9]{0,9})$/.exec(path)
    if (match) {
      const [, id] = match
      if (Number(id) > 4_294_967_295) throw invalidBody()
      if (method === 'GET') return json(response, 200, { row: await catalogEditor.get(id) })
      if (method === 'POST') {
        const { changes } = await readJson(request, 'changes', maxCatalogBody)
        return json(response, 200, { row: await catalogEditor.update(id, changes) })
      }
    } else if (path !== '/api/catalog') throw new HttpError(404, 'Страница не найдена.')
    throw new HttpError(405, 'Метод запроса недоступен.')
  }

  return async function handle(request, response) {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
    try {
      const separator = request.url.indexOf('?')
      const path = separator < 0 ? request.url : request.url.slice(0, separator)
      const query = separator < 0 ? '' : request.url.slice(separator + 1)
      const { method } = request
      const asset = files.get(path)
      if (asset && (method === 'GET' || method === 'HEAD')) {
        const [filename, contentType] = asset
        const body = await readFile(new URL('./public/' + filename, import.meta.url))
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length })
        return response.end(method === 'GET' ? body : undefined)
      }
      if ((method === 'POST' || method === 'DELETE') && !validOrigin(request)) {
        throw new HttpError(403, 'Источник запроса не подтверждён.')
      }
      if (path === '/api/session') return await session(request, response)
      const catalogPath = path === '/api/catalog' || path.startsWith('/api/catalog/')
      if (!catalogPath && path !== '/api/keys' && !path.startsWith('/api/keys/') && path !== '/api/logs' && path !== '/api/analytics') {
        throw new HttpError(404, 'Страница не найдена.')
      }
      if (!sessions.authenticated(request.headers.cookie)) throw new HttpError(401, 'Войдите в веб-админку.')
      if (catalogPath) return await catalog(request, response, path, query)
      if (path === '/api/analytics' || path === '/api/logs') {
        if (method !== 'GET') throw new HttpError(405, 'Метод запроса недоступен.')
        return path === '/api/analytics' ? await analytics(response, query) : await logPage(response, query)
      }
      if (path === '/api/keys' && method === 'GET') {
        return json(response, 200, { keys: (await repository.list()).map(keyMetadata) })
      }
      if (path === '/api/keys' && method === 'POST') {
        const { id, label: savedLabel, apiKey } = await repository.issue(await readLabel(request))
        return json(response, 201, { id: String(id), label: savedLabel, apiKey })
      }
      const match = /^\/api\/keys\/([1-9][0-9]{0,19})\/(logs|rename|revoke)$/.exec(path)
      if (!match) throw new HttpError(404, 'Страница не найдена.')
      const [, id, operation] = match
      if (BigInt(id) > maxKeyId) throw invalidBody()
      if (operation === 'logs' && method === 'GET') return await logPage(response, query, id)
      if (operation === 'rename' && method === 'POST') {
        const updated = await repository.rename(id, await readLabel(request))
        if (!updated) throw new HttpError(404, 'Ключ не найден.')
        return json(response, 200, { id, label: updated.label })
      }
      if (operation === 'revoke' && method === 'POST') {
        await readJson(request)
        const { revoked } = await repository.revoke(id)
        return json(response, 200, { id, revoked })
      }
      throw new HttpError(405, 'Метод запроса недоступен.')
    } catch (error) {
      if (response.destroyed || response.writableEnded) return
      if (response.headersSent) return response.destroy()
      const { status, message } = publicError(error)
      if (!request.complete) response.setHeader('Connection', 'close')
      json(response, status, { error: message })
    }
  }
}
