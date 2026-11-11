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
        throw new ApplicationError(grpc.status.PERMISSION_DENIED, 'API key is already bound to another device')
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
    label = typeof label === 'string' ? label.trim() : ''
    if (!label || label.length > 255 || /[\u0000-\u001f\u007f]/.test(label)) throw invalid()
    const apiKey = `mxk_${randomBytes(32).toString('base64url')}`
    const keyDigest = createHash('sha256').update(apiKey).digest()
    const result = await this.execute('INSERT INTO `access_keys` (`label`, `key_digest`) VALUES (?, ?)', [label, keyDigest])
    const id = BigInt.asUintN(64, BigInt(result.insertId)).toString()
    return { id, label, apiKey }
  }

  async list() {
    return await this.execute('SELECT `id`, `label`, `created_at`, `activated_at`, `revoked_at` FROM `access_keys` ORDER BY `id` DESC')
  }

  async revoke(id) {
    const result = await this.execute('UPDATE `access_keys` SET `revoked_at` = CURRENT_TIMESTAMP(3) WHERE `id` = ? AND `revoked_at` IS NULL', [validateId(id)])
    return { id, revoked: result.affectedRows === 1 }
  }

  async logs(id) {
    return await this.execute('SELECT `id`, `access_key_id`, `module`, `method`, `status_code`, `duration_ms`, `created_at` FROM `access_key_logs` WHERE `access_key_id` = ? ORDER BY `id` DESC LIMIT 1000', [validateId(id)])
  }
}
