import { DeviceAccessRepository } from '../node/infrastructure/mysql/device-access.mjs'
import { createMysqlPool } from '../node/infrastructure/mysql/pool.mjs'
import { readMysqlSettings } from '../node/infrastructure/mysql/settings.mjs'

const actions = new Map([['issue', 1], ['list', 0], ['revoke', 1], ['logs', 1]])
const [action, ...args] = process.argv.slice(2)

if (!actions.has(action) || args.length !== actions.get(action)) {
  console.error('Usage: access-keys.mjs issue <label> | list | revoke <id> | logs <id>')
  process.exitCode = 1
} else {
  let pool
  try {
    pool = createMysqlPool(readMysqlSettings())
    const repository = new DeviceAccessRepository(pool)
    console.log(JSON.stringify(await repository[action](...args)))
  } catch (error) {
    console.error(error?.code === 3 ? 'Invalid access key request' : 'Access key operation failed; check MySQL configuration and migrations')
    process.exitCode = 1
  } finally {
    await pool?.end()
  }
}
