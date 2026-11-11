import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const deriveKey = promisify(scrypt)
const scryptOptions = { N: 32_768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }
const saltLength = 16
const keyLength = 64
const sessionSeconds = 8 * 60 * 60
const cookieName = '__Host-matrix-admin'
const maxSessions = 32
const loginWindowMs = 5 * 60 * 1000
const loginAttempts = 5
const maxTrackedAddresses = 1024
const maxActiveVerifications = 2

export function isValidPassword(password) {
  return typeof password === 'string' && password.length > 0 && Buffer.byteLength(password, 'utf8') <= 1024
}

function decodeHash(hash) {
  if (typeof hash !== 'string') return
  const match = /^scrypt:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{86})$/.exec(hash)
  if (!match) return
  const [, encodedSalt, encodedDigest] = match
  const salt = Buffer.from(encodedSalt, 'base64url')
  const digest = Buffer.from(encodedDigest, 'base64url')
  if (salt.length !== saltLength || digest.length !== keyLength
    || salt.toString('base64url') !== encodedSalt || digest.toString('base64url') !== encodedDigest) return
  return { salt, digest }
}

export function isPasswordHash(hash) {
  return Boolean(decodeHash(hash))
}

export async function hashPassword(password) {
  if (!isValidPassword(password)) throw new TypeError('Invalid web admin password')
  const salt = randomBytes(saltLength)
  const digest = await deriveKey(password, salt, keyLength, scryptOptions)
  return ['scrypt', salt.toString('base64url'), digest.toString('base64url')].join(':')
}

export async function verifyPassword(password, hash) {
  const credentials = decodeHash(hash)
  if (!credentials || !isValidPassword(password)) return false
  const candidate = await deriveKey(password, credentials.salt, keyLength, scryptOptions)
  return timingSafeEqual(candidate, credentials.digest)
}

function sessionToken(cookie) {
  const prefix = cookieName + '='
  const matches = (cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix))
  if (matches.length !== 1) return
  const token = matches[0].slice(prefix.length)
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) return token
}

function sessionCookie(token, maxAge) {
  return `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

export function createSessions(now) {
  const sessions = new Map()
  return {
    authenticated(cookie) {
      const token = sessionToken(cookie)
      if (sessions.get(token) > now()) return true
      sessions.delete(token)
      return false
    },
    start(previousCookie) {
      sessions.delete(sessionToken(previousCookie))
      const startedAt = now()
      for (const [token, expires] of sessions) if (expires <= startedAt) sessions.delete(token)
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value)
      const token = randomBytes(32).toString('base64url')
      sessions.set(token, startedAt + sessionSeconds * 1000)
      return sessionCookie(token, sessionSeconds)
    },
    end(cookie) {
      sessions.delete(sessionToken(cookie))
      return sessionCookie('', 0)
    },
  }
}

export function createLoginLimiter(now) {
  const addresses = new Map()
  let active = 0
  return (address) => {
    const startedAt = now()
    for (const [key, entry] of addresses) if (entry.expires <= startedAt) addresses.delete(key)
    let entry = addresses.get(address)
    if (entry?.attempts >= loginAttempts) return { retryAfter: Math.ceil((entry.expires - startedAt) / 1000) }
    if (active >= maxActiveVerifications) return { retryAfter: 1 }
    if (!entry) {
      if (addresses.size >= maxTrackedAddresses) return { retryAfter: Math.ceil(loginWindowMs / 1000) }
      entry = { attempts: 0, expires: startedAt + loginWindowMs }
      addresses.set(address, entry)
    }
    entry.attempts++
    active++
    return {
      finish(accepted) {
        active--
        if (accepted && addresses.get(address) === entry) addresses.delete(address)
      },
    }
  }
}
