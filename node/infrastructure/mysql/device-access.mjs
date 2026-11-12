import { createHash, randomBytes } from 'node:crypto'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'

const maxId = 18_446_744_073_709_551_615n
const invalid = () => new ApplicationError(grpc.status.INVALID_ARGUMENT, 'Invalid access key request')
const unavailable = () => new ApplicationError(grpc.status.UNAVAILABLE, 'Operational database is unavailable')

function validateId(id) {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > maxId) throw invalid()
  return id
}

function validateLabel(value) {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!label || label.length > 255 || /[\u0000-\u001f\u007f]/.test(label)) throw invalid()
  return label
}

const logResults = new Map([
  ['success', 'l.`status_code` = 0'],
  ['cancelled', 'l.`status_code` = 1'],
  ['error', 'l.`status_code` NOT IN (0, 1)'],
])
const logCounts = 'COUNT(*) AS requests, COUNT(CASE WHEN `status_code` NOT IN (0, 1) THEN 1 END) AS errors'

function logMetrics({ requests, errors }) {
  return { requests: Number(requests), errors: Number(errors) }
}

export class DeviceAccessRepository {
  constructor(pool, { now = Date.now } = {}) {
    this.pool = pool
    this.now = now
  }

  async authorize({ keyDigest, deviceKey, nonce, expiresAt }) {
    let connection
    let transactionOpen = false
    let discardConnection = false
    try {
      connection = await this.pool.getConnection()
      transactionOpen = true
      await connection.beginTransaction()
      const [[key]] = await connection.execute(
        'SELECT `id`, `device_key` FROM `access_keys` WHERE `key_digest` = ? AND `revoked_at` IS NULL FOR UPDATE', [keyDigest],
      )
      const now = this.now()
      if (!key || expiresAt < now) return null
      if (key.device_key && !key.device_key.equals(deviceKey)) {
        const error = new ApplicationError(grpc.status.PERMISSION_DENIED, 'API key is already bound to another device')
        Object.defineProperty(error, 'accessKeyId', { value: String(key.id) })
        throw error
      }
      try {
        await connection.execute('INSERT INTO `access_key_nonces` (`access_key_id`, `nonce`, `expires_at`) VALUES (?, ?, ?)', [key.id, nonce, expiresAt])
      } catch (error) {
        if (error?.code === 'ER_DUP_ENTRY') return null
        throw error
      }
      if (!key.device_key) {
        await connection.execute('UPDATE `access_keys` SET `device_key` = ?, `activated_at` = CURRENT_TIMESTAMP(3) WHERE `id` = ?', [deviceKey, key.id])
      }
      await connection.execute('DELETE FROM `access_key_nonces` WHERE `access_key_id` = ? AND `expires_at` < ? ORDER BY `expires_at` LIMIT 128', [key.id, now])
      await connection.commit()
      transactionOpen = false
      return String(key.id)
    } catch (error) {
      if (error instanceof ApplicationError) throw error
      throw unavailable()
    } finally {
      if (transactionOpen) {
        try { await connection.rollback() }
        catch { discardConnection = true }
      }
      if (discardConnection) {
        try { connection.destroy() } catch {}
      } else connection?.release()
    }
  }

  async execute(sql, parameters = []) {
    try { const [result] = await this.pool.execute(sql, parameters); return result }
    catch { throw unavailable() }
  }

  async issue(label) {
    label = validateLabel(label)
    const apiKey = `mxk_${randomBytes(32).toString('base64url')}`
    const keyDigest = createHash('sha256').update(apiKey).digest()
    const result = await this.execute('INSERT INTO `access_keys` (`label`, `key_digest`) VALUES (?, ?)', [label, keyDigest])
    const id = BigInt.asUintN(64, BigInt(result.insertId)).toString()
    return { id, label, apiKey }
  }

  async list() {
    return await this.execute('SELECT `id`, `label`, `created_at`, `activated_at`, `revoked_at` FROM `access_keys` ORDER BY `id` DESC')
  }

  async rename(id, label) {
    validateId(id)
    label = validateLabel(label)
    const result = await this.execute('UPDATE `access_keys` SET `label` = ? WHERE `id` = CAST(? AS UNSIGNED)', [label, id])
    if (result.affectedRows) return { id, label }
    const [key] = await this.execute('SELECT `label` FROM `access_keys` WHERE `id` = CAST(? AS UNSIGNED)', [id])
    return key ? { id, label: key.label } : null
  }

  async revoke(id) {
    const result = await this.execute('UPDATE `access_keys` SET `revoked_at` = CURRENT_TIMESTAMP(3) WHERE `id` = ? AND `revoked_at` IS NULL', [validateId(id)])
    return { id, revoked: result.affectedRows === 1 }
  }

  async logs(id) {
    return await this.execute('SELECT `id`, `access_key_id`, `module`, `method`, `status_code`, `duration_ms`, `created_at` FROM `access_key_logs` WHERE `access_key_id` = ? ORDER BY `id` DESC LIMIT 1000', [validateId(id)])
  }

  async logPage({ id, from, method, result, before, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid()
    const conditions = []
    const parameters = []
    if (id != null) {
      conditions.push('l.`access_key_id` = CAST(? AS UNSIGNED)')
      parameters.push(validateId(id))
    }
    if (from != null) {
      conditions.push('l.`created_at` >= ?')
      parameters.push(from)
    }
    if (method != null) {
      conditions.push('l.`method` = ?')
      parameters.push(method)
    }
    if (result != null) {
      if (!logResults.has(result)) throw invalid()
      conditions.push(logResults.get(result))
    }
    if (before != null) {
      conditions.push('l.`id` < CAST(? AS UNSIGNED)')
      parameters.push(validateId(before))
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    const rows = await this.execute(`
      SELECT l.\`id\`, l.\`access_key_id\`, k.\`label\`, l.\`module\`, l.\`method\`, l.\`status_code\`, l.\`duration_ms\`, l.\`created_at\`
      FROM \`access_key_logs\` l INNER JOIN \`access_keys\` k ON k.\`id\` = l.\`access_key_id\`
      ${where}
      ORDER BY l.\`id\` DESC LIMIT ?`, [...parameters, limit + 1])
    const logs = rows.slice(0, limit)
    return { logs, nextCursor: rows.length > limit ? String(logs.at(-1).id) : null }
  }

  async analytics(from, owner) {
    if (owner !== undefined && validateLabel(owner) !== owner) throw invalid()
    const ownerParams = owner === undefined ? [] : [owner]
    const ownerFilter = owner === undefined ? '' : ' WHERE CAST(`label` AS BINARY) = CAST(? AS BINARY)'
    const logFilter = 'WHERE `created_at` >= ?' + (ownerFilter
      ? ' AND `access_key_id` IN (SELECT `id` FROM `access_keys`' + ownerFilter + ')'
      : '')
    const logParams = [from, ...ownerParams]
    const [[keys], [totals], daily, topKeys] = await Promise.all([
      this.execute(`
        SELECT COUNT(*) AS total,
          COUNT(CASE WHEN \`activated_at\` IS NOT NULL AND \`revoked_at\` IS NULL THEN 1 END) AS bound,
          COUNT(CASE WHEN \`activated_at\` IS NULL AND \`revoked_at\` IS NULL THEN 1 END) AS pending,
          COUNT(\`revoked_at\`) AS revoked
        FROM \`access_keys\`${ownerFilter}`, ownerParams),
      this.execute(`
        SELECT ${logCounts}, COUNT(DISTINCT \`access_key_id\`) AS activeKeys,
          COALESCE(AVG(\`duration_ms\`), 0) AS averageMs
        FROM \`access_key_logs\` ${logFilter}`, logParams),
      this.execute(`
        SELECT DATE(\`created_at\`) AS \`day\`, ${logCounts}
        FROM \`access_key_logs\` ${logFilter}
        GROUP BY \`day\` ORDER BY \`day\``, logParams),
      this.execute(`
        SELECT k.\`id\`, k.\`label\`, counts.requests, counts.errors
        FROM (
          SELECT \`access_key_id\`, ${logCounts}
          FROM \`access_key_logs\` ${logFilter}
          GROUP BY \`access_key_id\` ORDER BY requests DESC, \`access_key_id\` LIMIT 10
        ) counts INNER JOIN \`access_keys\` k ON k.\`id\` = counts.\`access_key_id\`
        ORDER BY counts.requests DESC, k.\`id\``, logParams),
    ])
    return {
      keys: { total: Number(keys.total), bound: Number(keys.bound), pending: Number(keys.pending), revoked: Number(keys.revoked) },
      totals: { ...logMetrics(totals), activeKeys: Number(totals.activeKeys), averageMs: Number(totals.averageMs) },
      daily: daily.map(row => ({ day: row.day, ...logMetrics(row) })),
      topKeys: topKeys.map(row => ({ id: String(row.id), label: row.label, ...logMetrics(row) })),
    }
  }
}
