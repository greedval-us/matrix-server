import { readFile } from 'node:fs/promises'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'

// The published catalogue belongs to an immutable resumable index plan. CRUD
// must not retire an ID and then silently reuse it for a different source.
export function createCatalogGuard(snapshotPath) {
  return async ({ id }) => {
    let snapshot
    try { snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') return
      throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Cannot verify published catalogue identities')
    }
    if (!Array.isArray(snapshot.databases)) throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Cannot verify published catalogue identities')
    if (!snapshot.databases.length) return
    if (!id || snapshot.databases.some(row => String(row.id) === id)) {
      throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Catalogue identity is reserved by an index plan; use a new explicit ID or rebuild the plan')
    }
  }
}
