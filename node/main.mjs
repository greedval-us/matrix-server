import { readFile } from 'node:fs/promises'
import grpc from '@grpc/grpc-js'
import { readSettings } from './config.mjs'
import { createApplication } from './application.mjs'

async function main() {
  const settings = readSettings()
  const credentials = settings.tlsCertPath
    ? grpc.ServerCredentials.createSsl(null, [{
        cert_chain: await readFile(settings.tlsCertPath),
        private_key: await readFile(settings.tlsKeyPath),
      }], false)
    : grpc.ServerCredentials.createInsecure()
  const application = await createApplication(settings)
  const address = `${settings.grpcHost}:${settings.grpcPort}`
  try {
    await new Promise((resolve, reject) => application.server.bindAsync(address, credentials, error => error ? reject(error) : resolve()))
  } catch (error) { await application.close(); throw error }
  console.log(`[matrix] gRPC listening on ${address} tls=${Boolean(settings.tlsCertPath)} modules=${settings.moduleIds.join(',')}`)

  let stopping = false
  const shutdown = async (signal) => {
    if (stopping) return
    stopping = true
    console.log(`[matrix] received ${signal}, stopping`)
    try { await application.close() }
    catch { console.error('[matrix] shutdown failed'); process.exitCode = 1 }
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(() => {
  console.error('[matrix] startup failed; check configuration and dependencies')
  process.exitCode = 1
})
