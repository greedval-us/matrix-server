import { createHash, timingSafeEqual } from 'node:crypto'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from './errors.mjs'

const digest = value => createHash('sha256').update(String(value)).digest()

export function createAuthorizer({ apiKey, adminApiKey }) {
  const keys = { search: digest(apiKey), admin: adminApiKey ? digest(adminApiKey) : null }
  return (call, access = 'search') => {
    const expected = keys[access]
    const supplied = call.metadata.get('x-api-key')[0] ?? ''
    if (!expected || !timingSafeEqual(expected, digest(supplied))) throw new ApplicationError(grpc.status.UNAUTHENTICATED, 'Invalid API key')
  }
}
