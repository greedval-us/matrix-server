import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from './errors.mjs'

const digest = value => createHash('sha256').update(String(value)).digest()
const maximumClockSkew = 120_000
const invalidKey = () => new ApplicationError(grpc.status.UNAUTHENTICATED, 'Invalid API key or device proof')

function metadataText(call, name) {
  const values = call.metadata.get(name)
  return values.length === 1 && typeof values[0] === 'string' ? values[0] : ''
}

function decodeCanonical(text, length) {
  if (text.length !== Math.ceil(length * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(text)) throw invalidKey()
  const bytes = Buffer.from(text, 'base64url')
  if (bytes.length !== length || bytes.toString('base64url') !== text) throw invalidKey()
  return bytes
}

function verifiedClaim(call, supplied, now) {
  if (!supplied.startsWith('mxk_')) throw invalidKey()
  decodeCanonical(supplied.slice(4), 32)
  const keyDigest = digest(supplied)
  const time = metadataText(call, 'x-matrix-device-time')
  const signedAt = Number(time)
  const path = call.getPath?.()
  if (!/^[1-9][0-9]{0,15}$/.test(time) || !Number.isSafeInteger(signedAt)
    || Math.abs(now - signedAt) > maximumClockSkew || typeof path !== 'string'
    || !/^\/[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/.test(path)) throw invalidKey()

  const deviceKey = decodeCanonical(metadataText(call, 'x-matrix-device-key'), 44)
  const nonceText = metadataText(call, 'x-matrix-device-nonce')
  const nonce = decodeCanonical(nonceText, 16)
  const signature = decodeCanonical(metadataText(call, 'x-matrix-device-signature'), 64)
  let publicKey
  try { publicKey = createPublicKey({ key: deviceKey, format: 'der', type: 'spki' }) }
  catch { throw invalidKey() }
  const payload = Buffer.from(['matrix-device-v1', path, keyDigest.toString('hex'), time, nonceText].join('\n'))
  if (publicKey.asymmetricKeyType !== 'ed25519' || !publicKey.export({ format: 'der', type: 'spki' }).equals(deviceKey)
    || !verify(null, payload, publicKey, signature)) throw invalidKey()

  return { keyDigest, deviceKey, nonce, now, expiresAt: signedAt + maximumClockSkew }
}

export function createAuthorizer({ apiKey, adminApiKey, authMode = 'shared' }, { deviceRepository, now = Date.now } = {}) {
  if (authMode === 'device' && !deviceRepository) throw new Error('Device authorization requires its repository')
  const keys = { search: apiKey ? digest(apiKey) : null, admin: adminApiKey ? digest(adminApiKey) : null }
  return async (call, access = 'search') => {
    const supplied = metadataText(call, 'x-api-key')
    if (authMode === 'device' && access === 'search') {
      const accessKeyId = await deviceRepository.authorize(verifiedClaim(call, supplied, now()))
      if (!accessKeyId) throw invalidKey()
      return { accessKeyId }
    }
    const expected = keys[access]
    if (!expected || !timingSafeEqual(expected, digest(supplied))) throw new ApplicationError(grpc.status.UNAUTHENTICATED, 'Invalid API key')
  }
}
