import { performance } from 'node:perf_hooks'
import grpc from '@grpc/grpc-js'
import { toRpcError } from './errors.mjs'

export function createRpcHandlers({ authorize, audit }) {
  function completion(module, method) {
    const started = performance.now()
    let finished = false
    return statusCode => {
      if (finished) return
      finished = true
      audit.record({ module, method, statusCode, durationMs: Math.max(0, Math.round(performance.now() - started)) })
    }
  }
  return {
    unary(module, method, handler, access = 'search') {
      return async (call, callback) => {
        const complete = completion(module, method)
        try {
          authorize(call, access)
          const response = await handler(call.request, call)
          callback(null, response)
          complete(grpc.status.OK)
        } catch (error) {
          const safe = toRpcError(error)
          callback(safe)
          complete(safe.code)
        }
      }
    },
    stream(module, method, handler, access = 'search') {
      return async call => {
        const complete = completion(module, method)
        call.once('finish', () => complete(grpc.status.OK))
        call.once('cancelled', () => complete(grpc.status.CANCELLED))
        call.once('error', error => complete(error.code ?? grpc.status.INTERNAL))
        try { authorize(call, access); await handler(call) }
        catch (error) {
          const safe = toRpcError(error)
          complete(safe.code)
          call.emit('error', safe)
        }
      }
    },
  }
}
