import grpc from '@grpc/grpc-js'
import { createAuthorizer } from './core/auth.mjs'
import { createAuditLog } from './core/audit.mjs'
import { createRpcHandlers } from './core/rpc.mjs'
import { loadService } from './core/protos.mjs'
import { modules } from './modules/index.mjs'
import { createCatalogGuard } from './modules/catalog/guard.mjs'

export async function createApplication(settings, dependencies = {}) {
  let pool = dependencies.pool
  let repository = dependencies.repository
  try {
    if (!repository && settings.mysql) {
      if (!pool) {
        const { createMysqlPool } = await import('./infrastructure/mysql/pool.mjs')
        pool = createMysqlPool(settings.mysql)
      }
      const { OperationalRepository } = await import('./infrastructure/mysql/repository.mjs')
      await pool.execute('SELECT 1')
      repository = new OperationalRepository(pool, { catalogGuard: createCatalogGuard(settings.databaseCatalogPath) })
    }
    const server = new grpc.Server({
      'grpc.max_receive_message_length': 1024 * 1024,
      'grpc.max_send_message_length': 32 * 1024 * 1024,
      'grpc.keepalive_time_ms': 60_000,
      'grpc.keepalive_timeout_ms': 10_000,
    })
    const audit = createAuditLog(repository, dependencies.auditOptions)
    const rpc = createRpcHandlers({ authorize: createAuthorizer(settings), audit })
    for (const id of settings.moduleIds) {
      const module = modules.find(candidate => candidate.id === id)
      if (!module) throw new Error(`Unknown module: ${id}`)
      module.register({ server, settings, repository, pool, controlRepository: dependencies.controlRepository, fileStore: dependencies.fileStore, loadService, rpc })
    }
    let closing
    return {
      server,
      close() {
        closing ??= (async () => {
          await new Promise(resolve => {
            const timeout = setTimeout(() => server.forceShutdown(), 15_000)
            server.tryShutdown(() => { clearTimeout(timeout); resolve() })
          })
          await audit.close()
          if (pool) await pool.end()
        })()
        return closing
      },
    }
  } catch (error) {
    if (pool) await pool.end()
    throw error
  }
}
