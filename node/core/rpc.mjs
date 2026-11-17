import { performance } from 'node:perf_hooks'
import grpc from '@grpc/grpc-js'
import { toRpcError } from './errors.mjs'

export function createRpcHandlers({ authorize, audit }) {
  function completion(module, method) {
    const started = performance.now()
    let accessKeyId
    let identityResolved = false
    let terminal
    let recorded = false
    let searchFields
    let searchHadMatches
    const personalSearch = module === 'search' && method === 'StreamSearch'

    function record() {
      if (recorded || !terminal || !identityResolved) return
      recorded = true
      const metadata = { module, method, ...terminal }
      if (accessKeyId) metadata.accessKeyId = accessKeyId
      if (searchFields?.length) {
        metadata.searchFields = searchFields
        if (terminal.statusCode === grpc.status.OK && typeof searchHadMatches === 'boolean') {
          metadata.searchHadMatches = searchHadMatches
        }
      }
      audit.record(metadata)
    }

    return {
      async identify(call, access) {
        try { accessKeyId = (await authorize(call, access))?.accessKeyId }
        catch (error) {
          if (error?.code === grpc.status.PERMISSION_DENIED) accessKeyId = error.accessKeyId
          throw error
        } finally {
          identityResolved = true
          record()
        }
      },
      searchObservers() {
        if (!personalSearch || !accessKeyId) return undefined
        return {
          onSearchFields: fields => { searchFields = fields },
          onSearchComplete: hadMatches => { searchHadMatches = hadMatches },
        }
      },
      finish(statusCode) {
        terminal ??= { statusCode, durationMs: Math.max(0, Math.round(performance.now() - started)) }
        record()
      },
    }
  }
  return {
    unary(module, method, handler, access = 'search') {
      return async (call, callback) => {
        const request = completion(module, method)
        try {
          await request.identify(call, access)
          if (call.cancelled) {
            request.finish(grpc.status.CANCELLED)
            return
          }
          const response = await handler(call.request, call)
          callback(null, response)
          request.finish(grpc.status.OK)
        } catch (error) {
          const safe = toRpcError(error)
          callback(safe)
          request.finish(safe.code)
        }
      }
    },
    stream(module, method, handler, access = 'search') {
      return async call => {
        const request = completion(module, method)
        call.once('finish', () => request.finish(grpc.status.OK))
        call.once('cancelled', () => request.finish(grpc.status.CANCELLED))
        call.once('close', () => request.finish(grpc.status.CANCELLED))
        call.once('error', error => request.finish(error.code ?? grpc.status.INTERNAL))
        try {
          await request.identify(call, access)
          if (call.cancelled || call.destroyed) {
            request.finish(grpc.status.CANCELLED)
            return
          }
          await handler(call, request.searchObservers())
        } catch (error) {
          const safe = toRpcError(error)
          request.finish(safe.code)
          call.emit('error', safe)
        }
      }
    },
  }
}
