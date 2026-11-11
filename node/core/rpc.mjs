import { performance } from 'node:perf_hooks'
import grpc from '@grpc/grpc-js'
import { toRpcError } from './errors.mjs'

export function createRpcHandlers({ authorize, audit }) {
  function completion(module, method) {
    const started = performance.now()
    let finished = false
    let accessKeyId
    return {
      identify(principal) { accessKeyId = principal?.accessKeyId },
      finish(statusCode) {
        if (finished) return
        finished = true
        const metadata = { module, method, statusCode, durationMs: Math.max(0, Math.round(performance.now() - started)) }
        if (accessKeyId) metadata.accessKeyId = accessKeyId
        audit.record(metadata)
      },
    }
  }
  return {
    unary(module, method, handler, access = 'search') {
      return async (call, callback) => {
        const request = completion(module, method)
        try {
          request.identify(await authorize(call, access))
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
        call.once('error', error => request.finish(error.code ?? grpc.status.INTERNAL))
        try {
          request.identify(await authorize(call, access))
          if (call.cancelled || call.destroyed) return
          await handler(call)
        } catch (error) {
          const safe = toRpcError(error)
          request.finish(safe.code)
          call.emit('error', safe)
        }
      }
    },
  }
}
