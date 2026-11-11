import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { DeviceAccessRepository } from '../infrastructure/mysql/device-access.mjs'
import { createMysqlPool } from '../infrastructure/mysql/pool.mjs'
import { readMysqlSettings } from '../infrastructure/mysql/settings.mjs'
import { createWebAdminHandler } from './app.mjs'

function configuredNetworks(value) {
  if (!value.trim()) return null
  const networks = new BlockList()
  networks.addSubnet('127.0.0.0', 8, 'ipv4')
  networks.addAddress('::1', 'ipv6')
  for (const network of value.split(',')) {
    const parts = network.trim().split('/')
    const [address, prefix] = parts
    const version = isIP(address)
    if (parts.length !== 2 || !version || !/^\d{1,3}$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)) {
      throw new Error('Invalid MATRIX_WEB_ADMIN_ALLOWED_CIDRS')
    }
    networks.addSubnet(address, Number(prefix), version === 4 ? 'ipv4' : 'ipv6')
  }
  return networks
}

function isoTimestamp(value) {
  return value ? value.replace(' ', 'T') + 'Z' : null
}

async function main() {
  const e = process.env
  const host = e.MATRIX_WEB_ADMIN_HOST ?? '0.0.0.0'
  const port = Number(e.MATRIX_WEB_ADMIN_PORT ?? 8443)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid admin port')
  const networks = configuredNetworks(e.MATRIX_WEB_ADMIN_ALLOWED_CIDRS ?? '')
  const [cert, key, passwordHash] = await Promise.all([
    readFile(e.MATRIX_WEB_ADMIN_TLS_CERT),
    readFile(e.MATRIX_WEB_ADMIN_TLS_KEY),
    readFile(e.MATRIX_WEB_ADMIN_PASSWORD_HASH_FILE, 'utf8'),
  ])

  const pool = createMysqlPool(readMysqlSettings())
  pool.on('connection', connection => connection.query("SET time_zone = '+00:00'", error => {
    if (error) connection.destroy()
  }))
  try {
    await pool.execute('SELECT `access_keys`.`id`, `access_key_logs`.`access_key_id` FROM `access_keys`, `access_key_logs` LIMIT 0')
    const keys = new DeviceAccessRepository(pool)
    const repository = {
      async list() {
        return (await keys.list()).map(row => ({
          ...row,
          created_at: isoTimestamp(row.created_at),
          activated_at: isoTimestamp(row.activated_at),
          revoked_at: isoTimestamp(row.revoked_at),
        }))
      },
      async logPage(filters) {
        const page = await keys.logPage(filters)
        return { ...page, logs: page.logs.map(row => ({ ...row, created_at: isoTimestamp(row.created_at) })) }
      },
      analytics: from => keys.analytics(from),
      issue: label => keys.issue(label),
      rename: (id, label) => keys.rename(id, label),
      revoke: id => keys.revoke(id),
    }
    const handler = createWebAdminHandler({ repository, passwordHash: passwordHash.trim() })
    const server = createServer({ cert, key, minVersion: 'TLSv1.2', requestTimeout: 15_000,
      headersTimeout: 10_000, keepAliveTimeout: 5000, maxHeaderSize: 8192 }, handler)
    if (networks) server.on('connection', socket => {
      const address = socket.remoteAddress ?? ''
      const version = isIP(address)
      if (!version || !networks.check(address, version === 4 ? 'ipv4' : 'ipv6')) socket.destroy()
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => { server.off('error', reject); resolve() })
    })
    console.log('[matrix-web-admin] HTTPS ready')

    let closing = false
    const close = () => {
      if (closing) return
      closing = true
      const timeout = setTimeout(() => server.closeAllConnections(), 5000)
      timeout.unref()
      server.close(() => {
        clearTimeout(timeout)
        void pool.end().catch(() => { process.exitCode = 1 })
      })
    }
    process.on('SIGINT', close)
    process.on('SIGTERM', close)
  } catch (error) {
    await pool.end()
    throw error
  }
}

main().catch(() => {
  console.error('[matrix-web-admin] startup failed; check HTTPS, secrets, and access-key tables')
  process.exitCode = 1
})
