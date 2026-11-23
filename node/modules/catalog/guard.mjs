import { readFile } from 'node:fs/promises'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'

// The published catalogue belongs to an immutable resumable index plan. CRUD
// must not retire an ID and then silently reuse it for a different source.
export function createCatalogGuard(snapshotPath) {
  return async ({ id, tableName, findAvailable = false }) => {
    let snapshot
    try { snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) }
    catch (error) {
      if (error.code === 'ENOENT') return
      throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Cannot verify published catalogue identities')
    }
    if (!Array.isArray(snapshot?.databases)) throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Cannot verify published catalogue identities')
    if (!snapshot.databases.length) return
    const reserved = new Set()
    for (const row of snapshot.databases) {
      const value = Number(row?.id)
      if (!Number.isSafeInteger(value) || value < 1 || value > 4294967295 || !row?.name_table) {
        throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Cannot verify published catalogue identities')
      }
      if (row.name_table === tableName) {
        throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Source table name is reserved by an index plan')
      }
      reserved.add(value)
    }
    if (findAvailable && id && reserved.has(Number(id))) {
      let next = Number(id)
      while (reserved.has(next)) next++
      if (next > 4294967295) throw new ApplicationError(grpc.status.RESOURCE_EXHAUSTED, 'No catalogue IDs available')
      return String(next)
    }
    if (!id || reserved.has(Number(id))) {
      throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Catalogue identity is reserved by an index plan; use a new explicit ID or rebuild the plan')
    }
  }
}
