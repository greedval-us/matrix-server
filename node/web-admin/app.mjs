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
const maxKeyId = 18_446_744_073_709_551_615n

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function invalidBody() {
  return new HttpError(400, 'Некорректные данные запроса.')
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

async function readJson(request, property) {
  const mime = (request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
  if (mime !== 'application/json') throw new HttpError(415, 'Отправьте запрос в формате JSON.')
  const tooLarge = () => new HttpError(413, 'Запрос слишком большой.')
  if (Number(request.headers['content-length']) > maxBody) throw tooLarge()
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBody) throw tooLarge()
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

function keyMetadata({ id, label, created_at, activated_at, revoked_at }) {
  return { id: String(id), label, created_at, activated_at, revoked_at }
}

function logMetadata({ id, access_key_id, module, method, status_code, duration_ms, created_at }) {
  return { id: String(id), access_key_id: String(access_key_id), module, method, status_code, duration_ms, created_at }
}

function publicError(error) {
  if (error instanceof HttpError) return error
  if (error?.code === 3) return invalidBody()
  if (error?.code === 14) return new HttpError(503, 'База данных временно недоступна.')
  return new HttpError(500, 'Не удалось выполнить запрос.')
}

export function createWebAdminHandler({ repository, passwordHash, now = Date.now }) {
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

  return async function handle(request, response) {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value)
    try {
      const path = request.url.split('?', 1)[0]
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
      if (!path.startsWith('/api/keys')) throw new HttpError(404, 'Страница не найдена.')
      if (!sessions.authenticated(request.headers.cookie)) throw new HttpError(401, 'Войдите в веб-админку.')
      if (path === '/api/keys' && method === 'GET') {
        return json(response, 200, { keys: (await repository.list()).map(keyMetadata) })
      }
      if (path === '/api/keys' && method === 'POST') {
        const input = await readJson(request, 'label')
        const label = typeof input.label === 'string' ? input.label.trim() : ''
        if (!label || label.length > 255 || /[\u0000-\u001f\u007f]/.test(label)) throw invalidBody()
        const { id, label: savedLabel, apiKey } = await repository.issue(label)
        return json(response, 201, { id: String(id), label: savedLabel, apiKey })
      }
      const match = /^\/api\/keys\/([1-9][0-9]{0,19})\/(logs|revoke)$/.exec(path)
      if (!match) throw new HttpError(404, 'Страница не найдена.')
      const [, id, operation] = match
      if (BigInt(id) > maxKeyId) throw invalidBody()
      if (operation === 'logs' && method === 'GET') {
        return json(response, 200, { logs: (await repository.logs(id)).map(logMetadata) })
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
