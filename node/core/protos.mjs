import { fileURLToPath } from 'node:url'
import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

export function loadService(fileName, serviceName) {
  const definition = protoLoader.loadSync(fileURLToPath(new URL(`../../protos/${fileName}`, import.meta.url)), {
    keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
  })
  return serviceName.split('.').reduce((value, key) => value[key], grpc.loadPackageDefinition(definition)).service
}
