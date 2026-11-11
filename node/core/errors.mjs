import grpc from '@grpc/grpc-js'

export const APPLICATION_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: grpc.status.INVALID_ARGUMENT,
  RESOURCE_EXHAUSTED: grpc.status.RESOURCE_EXHAUSTED,
  UNAVAILABLE: grpc.status.UNAVAILABLE,
})

export class ApplicationError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

const publicCodes = new Set([
  grpc.status.CANCELLED, grpc.status.INVALID_ARGUMENT, grpc.status.NOT_FOUND,
  grpc.status.ALREADY_EXISTS, grpc.status.PERMISSION_DENIED,
  grpc.status.RESOURCE_EXHAUSTED, grpc.status.FAILED_PRECONDITION,
  grpc.status.UNAUTHENTICATED, grpc.status.DEADLINE_EXCEEDED,
])

export function toRpcError(error) {
  if (publicCodes.has(error?.code)) return new ApplicationError(error.code, error.message)
  if (error?.code === grpc.status.UNAVAILABLE) return new ApplicationError(grpc.status.UNAVAILABLE, 'Service dependency is unavailable')
  return new ApplicationError(grpc.status.INTERNAL, 'Request failed')
}
