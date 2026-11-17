import { createHash, randomBytes } from 'node:crypto'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'
import { SEARCH_FIELDS } from '../../modules/search/normalization.mjs'

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
const backgroundCheck = `(l.\`module\` = 'search' AND l.\`method\` = 'GetIndexStatus'
  OR l.\`module\` = 'records' AND l.\`method\` = 'GetCapabilities')`
const logCounts = `COUNT(*) AS requests,
  COUNT(CASE WHEN l.\`status_code\` = 0 THEN 1 END) AS successes,
  COUNT(CASE WHEN l.\`status_code\` NOT IN (0, 1) THEN 1 END) AS errors,
  COUNT(CASE WHEN l.\`status_code\` = 1 THEN 1 END) AS cancelled`
const checkCount = `COUNT(CASE WHEN ${backgroundCheck} THEN 1 END) AS checks`
const searchRequest = "l.`module` = 'search' AND l.`method` = 'StreamSearch'"
const searchOutcomes = `COUNT(*) AS searchRequests,
  COUNT(CASE WHEN l.\`status_code\` = 0 AND l.\`search_had_matches\` = 1 THEN 1 END) AS withMatches,
  COUNT(CASE WHEN l.\`status_code\` = 0 AND l.\`search_had_matches\` = 0 THEN 1 END) AS withoutMatches`
const keyCounts = `COUNT(*) AS total,
  COUNT(CASE WHEN k.\`activated_at\` IS NOT NULL AND k.\`revoked_at\` IS NULL THEN 1 END) AS bound,
  COUNT(CASE WHEN k.\`activated_at\` IS NULL AND k.\`revoked_at\` IS NULL THEN 1 END) AS pending,
  COUNT(k.\`revoked_at\`) AS revoked`

function logMetrics({ requests, errors }) {
  return { requests: Number(requests), errors: Number(errors) }
}

function keyMetrics({ total, bound, pending, revoked }) {
  return { total: Number(total), bound: Number(bound), pending: Number(pending), revoked: Number(revoked) }
}

function outcomes(row) {
  return { ...logMetrics(row), successes: Number(row.successes), cancelled: Number(row.cancelled) }
}

function activity(row) {
  const counts = outcomes(row)
  const checks = Number(row.checks)
  return { ...counts, actions: counts.requests - checks, checks }
}

function searchMetrics(row) {
  const requests = Number(row.searchRequests)
  const withMatches = Number(row.withMatches)
  const withoutMatches = Number(row.withoutMatches)
  return { requests, withMatches, withoutMatches, unknown: requests - withMatches - withoutMatches }
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

  async analytics(from, owner, result = 'all') {
    if (owner !== undefined && validateLabel(owner) !== owner) throw invalid()
    if (result !== 'all' && !logResults.has(result)) throw invalid()
    const ownerParams = owner === undefined ? [] : [owner]
    const ownerFilter = owner === undefined ? '' : ' WHERE CAST(k.`label` AS BINARY) = CAST(? AS BINARY)'
    const logFilter = 'WHERE l.`created_at` >= ?' + (ownerFilter
      ? ' AND l.`access_key_id` IN (SELECT k.`id` FROM `access_keys` k' + ownerFilter + ')'
      : '') + (result === 'all' ? '' : ' AND ' + logResults.get(result))
    const logParams = [from, ...ownerParams]
    const [[keys], [totals], daily, topKeys, owners, operations, errorCodes, search] = await Promise.all([
      this.execute(`
        SELECT ${keyCounts}, COUNT(DISTINCT CAST(k.\`label\` AS BINARY)) AS ownerCount
        FROM \`access_keys\` k${ownerFilter}`, ownerParams),
      this.execute(`
        SELECT ${logCounts}, ${checkCount}, COUNT(DISTINCT l.\`access_key_id\`) AS activeKeys,
          COUNT(DISTINCT CASE WHEN NOT ${backgroundCheck} THEN CAST(k.\`label\` AS BINARY) END) AS activeOwners,
          COALESCE(AVG(l.\`duration_ms\`), 0) AS averageMs, MAX(l.\`created_at\`) AS lastActivity
        FROM \`access_key_logs\` l INNER JOIN \`access_keys\` k ON k.\`id\` = l.\`access_key_id\`
        ${logFilter}`, logParams),
      this.execute(`
        SELECT DATE(l.\`created_at\`) AS \`day\`, ${logCounts}, ${checkCount}
        FROM \`access_key_logs\` l ${logFilter}
        GROUP BY \`day\` ORDER BY \`day\``, logParams),
      this.execute(`
        SELECT k.\`id\`, k.\`label\`, counts.requests, counts.errors
        FROM (
          SELECT l.\`access_key_id\`, ${logCounts}
          FROM \`access_key_logs\` l ${logFilter}
          GROUP BY l.\`access_key_id\` ORDER BY requests DESC, l.\`access_key_id\` LIMIT 10
        ) counts INNER JOIN \`access_keys\` k ON k.\`id\` = counts.\`access_key_id\`
        ORDER BY counts.requests DESC, k.\`id\``, logParams),
      this.execute(`
        WITH key_activity AS (
          SELECT l.\`access_key_id\`, ${logCounts}, ${checkCount},
            COUNT(CASE WHEN ${searchRequest} THEN 1 END) AS searchRequests,
            COUNT(CASE WHEN ${searchRequest} AND l.\`status_code\` = 0 AND l.\`search_had_matches\` = 1 THEN 1 END) AS withMatches,
            COUNT(CASE WHEN ${searchRequest} AND l.\`status_code\` = 0 AND l.\`search_had_matches\` = 0 THEN 1 END) AS withoutMatches,
            SUM(l.\`duration_ms\`) AS durationTotal, MAX(l.\`created_at\`) AS lastActivity
          FROM \`access_key_logs\` l ${logFilter}
          GROUP BY l.\`access_key_id\`
        )
        SELECT ANY_VALUE(k.\`label\`) AS label, ${keyCounts}, COUNT(a.\`access_key_id\`) AS activeKeys,
          COALESCE(SUM(a.requests), 0) AS requests, COALESCE(SUM(a.successes), 0) AS successes,
          COALESCE(SUM(a.errors), 0) AS errors, COALESCE(SUM(a.cancelled), 0) AS cancelled,
          COALESCE(SUM(a.checks), 0) AS checks, COALESCE(SUM(a.requests - a.checks), 0) AS actions,
          COALESCE(SUM(a.searchRequests), 0) AS searchRequests,
          COALESCE(SUM(a.withMatches), 0) AS withMatches, COALESCE(SUM(a.withoutMatches), 0) AS withoutMatches,
          COALESCE(SUM(a.durationTotal) / NULLIF(SUM(a.requests), 0), 0) AS averageMs,
          MAX(a.lastActivity) AS lastActivity
        FROM \`access_keys\` k LEFT JOIN key_activity a ON a.\`access_key_id\` = k.\`id\`${ownerFilter}
        GROUP BY CAST(k.\`label\` AS BINARY)
        ORDER BY actions DESC, requests DESC, CAST(k.\`label\` AS BINARY) LIMIT 20`, [...logParams, ...ownerParams]),
      this.execute(`
        WITH filtered_logs AS (
          SELECT l.\`module\`, l.\`method\`, l.\`status_code\`, l.\`duration_ms\`, l.\`created_at\`
          FROM \`access_key_logs\` l ${logFilter}
        ), operations AS (
          SELECT l.\`module\`, l.\`method\`, ${logCounts}, AVG(l.\`duration_ms\`) AS averageMs,
            MAX(l.\`created_at\`) AS lastActivity
          FROM filtered_logs l GROUP BY l.\`module\`, l.\`method\`
          ORDER BY requests DESC, l.\`module\`, l.\`method\` LIMIT 50
        ), success_durations AS (
          SELECT l.\`module\`, l.\`method\`, l.\`duration_ms\`, COUNT(*) AS samples
          FROM filtered_logs l INNER JOIN operations o USING (\`module\`, \`method\`)
          WHERE l.\`status_code\` = 0 GROUP BY l.\`module\`, l.\`method\`, l.\`duration_ms\`
        ), ranked_durations AS (
          SELECT \`module\`, \`method\`, \`duration_ms\`,
            SUM(samples) OVER (PARTITION BY \`module\`, \`method\` ORDER BY \`duration_ms\`) AS cumulative,
            SUM(samples) OVER (PARTITION BY \`module\`, \`method\`) AS sampleCount
          FROM success_durations
        ), percentiles AS (
          SELECT \`module\`, \`method\`, MIN(\`duration_ms\`) AS p95SuccessMs
          FROM ranked_durations WHERE cumulative >= CEIL(sampleCount * 0.95) GROUP BY \`module\`, \`method\`
        )
        SELECT o.*, p.p95SuccessMs FROM operations o LEFT JOIN percentiles p USING (\`module\`, \`method\`)
        ORDER BY o.requests DESC, o.\`module\`, o.\`method\``, logParams),
      this.execute(`
        SELECT l.\`status_code\` AS code, COUNT(*) AS requests
        FROM \`access_key_logs\` l ${logFilter} AND l.\`status_code\` NOT IN (0, 1)
        GROUP BY l.\`status_code\` ORDER BY requests DESC, code`, logParams),
      this.#readSearchUsage(logFilter, logParams),
    ])
    return {
      keys: keyMetrics(keys),
      totals: { ...logMetrics(totals), activeKeys: Number(totals.activeKeys), averageMs: Number(totals.averageMs) },
      daily: daily.map(row => ({ day: row.day, ...logMetrics(row) })),
      topKeys: topKeys.map(row => ({ id: String(row.id), label: row.label, ...logMetrics(row) })),
      usage: {
        successes: Number(totals.successes), cancelled: Number(totals.cancelled),
        actions: Number(totals.requests) - Number(totals.checks), checks: Number(totals.checks),
        activeOwners: Number(totals.activeOwners), ownerCount: Number(keys.ownerCount), lastActivity: totals.lastActivity,
        daily: daily.map(row => ({ day: row.day, ...activity(row) })),
        owners: owners.map(row => ({
          label: row.label, keys: keyMetrics(row), ...activity(row), activeKeys: Number(row.activeKeys),
          averageMs: Number(row.averageMs), lastActivity: row.lastActivity, search: searchMetrics(row),
        })),
        operations: operations.map(row => ({
          module: row.module, method: row.method, ...outcomes(row), averageMs: Number(row.averageMs),
          p95SuccessMs: row.p95SuccessMs === null ? null : Number(row.p95SuccessMs), lastActivity: row.lastActivity,
          background: (row.module === 'search' && row.method === 'GetIndexStatus') ||
            (row.module === 'records' && row.method === 'GetCapabilities'),
        })),
        errorCodes: errorCodes.map(row => ({ code: Number(row.code), requests: Number(row.requests) })),
        search,
      },
    }
  }

  async #readSearchUsage(logFilter, logParams) {
    const rows = await this.execute(`
      WITH filtered_searches AS (
        SELECT l.\`id\`, l.\`status_code\`, l.\`duration_ms\`, l.\`search_had_matches\`, l.\`search_fields\`
        FROM \`access_key_logs\` l ${logFilter} AND ${searchRequest}
      ), summary AS (
        SELECT ${searchOutcomes}, AVG(l.\`duration_ms\`) AS averageMs FROM filtered_searches l
      ), successful_durations AS (
        SELECT \`duration_ms\`, COUNT(*) AS samples FROM filtered_searches
        WHERE \`status_code\` = 0 GROUP BY \`duration_ms\`
      ), ranked_durations AS (
        SELECT \`duration_ms\`, SUM(samples) OVER (ORDER BY \`duration_ms\`) AS cumulative,
          SUM(samples) OVER () AS sampleCount FROM successful_durations
      ), field_keys (\`field\`) AS (
        ${SEARCH_FIELDS.map(() => 'SELECT ?').join(' UNION ALL ')}
      ), known_field_uses AS (
        SELECT s.\`id\`, f.\`field\` FROM filtered_searches s
        INNER JOIN field_keys f ON JSON_CONTAINS(s.\`search_fields\`, JSON_QUOTE(f.\`field\`))
      ), field_counts AS (
        SELECT \`field\`, COUNT(*) AS requests FROM known_field_uses GROUP BY \`field\`
      )
      SELECT summary.*, f.\`field\`, f.requests AS fieldRequests,
        (SELECT COUNT(DISTINCT \`id\`) FROM known_field_uses) AS knownFields,
        (SELECT MIN(\`duration_ms\`) FROM ranked_durations WHERE cumulative >= CEIL(sampleCount * 0.95)) AS p95SuccessMs
      FROM summary LEFT JOIN field_counts f ON TRUE ORDER BY f.requests DESC, f.\`field\``, [...logParams, ...SEARCH_FIELDS])
    const [summary] = rows
    return {
      ...searchMetrics(summary), knownFields: Number(summary.knownFields),
      averageMs: summary.averageMs === null ? null : Number(summary.averageMs),
      p95SuccessMs: summary.p95SuccessMs === null ? null : Number(summary.p95SuccessMs),
      fields: rows.filter(row => row.field !== null).map(row => ({ field: row.field, requests: Number(row.fieldRequests) })),
    }
  }
}
