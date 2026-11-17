export class ManticoreError extends Error {}

const BROAD_ID_WINDOW = 250_000
const BROAD_QUERY_TIME_MS = 120_000

function sqlString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function readDocumentIds(hits, after) {
  return hits.map(hit => {
    const id = String(hit._id)
    if (!/^\d{1,20}$/.test(id) || BigInt(id) <= after) {
      throw new ManticoreError('Manticore returned invalid or unordered document IDs')
    }
    after = BigInt(id)
    return id
  })
}

export class ManticoreClient {
  constructor({ baseUrl, table, maxQueryTimeMs, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl
    this.table = table
    this.maxQueryTimeMs = maxQueryTimeMs
    this.fetch = fetchImpl
  }

  async request(payload, signal, { sql = false, queryTimeMs = this.maxQueryTimeMs } = {}) {
    const controller = new AbortController()
    const abortRequest = () => controller.abort(signal?.reason)
    if (signal?.aborted) abortRequest()
    else signal?.addEventListener('abort', abortRequest, { once: true })
    const timeout = setTimeout(() => controller.abort(), queryTimeMs + 5000)

    try {
      const response = await this.fetch(`${this.baseUrl}/${sql ? 'sql' : 'search'}`, {
        method: 'POST',
        headers: { 'content-type': sql ? 'text/plain' : 'application/json' },
        body: sql ? payload : JSON.stringify(payload),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new ManticoreError(`Manticore returned HTTP ${response.status}: ${text.slice(0, 500)}`)
      }
      let body
      try {
        body = JSON.parse(text, (key, value, context) =>
          key === '_id' && typeof value === 'number' && !Number.isSafeInteger(value) ? context.source : value)
      } catch (error) {
        throw new ManticoreError(`Manticore returned invalid JSON: ${error.message}`)
      }
      if (body.error) {
        throw new ManticoreError(`Manticore search failed: ${String(body.error).slice(0, 500)}`)
      }
      const hitsNode = body.hits ?? {}
      const totalNode = hitsNode.total ?? 0
      const rawTotal = typeof totalNode === 'object' ? totalNode.value : totalNode
      const total = Number(rawTotal ?? 0)
      const hasTotal = hitsNode.total != null && (typeof rawTotal === 'number'
        || (typeof rawTotal === 'string' && /^\d+$/.test(rawTotal)))
      const complete = !body.timed_out && !body.warning && hitsNode.total_relation === 'eq'
        && hasTotal && Number.isSafeInteger(total) && total >= 0 && Array.isArray(hitsNode.hits)
      if (sql && !complete) {
        throw new ManticoreError('Manticore returned incomplete search results')
      }
      return {
        hits: Array.isArray(hitsNode.hits) ? hitsNode.hits : [],
        total: Number.isFinite(total) ? total : 0,
        complete,
        tookMs: Number(body.took ?? 0),
        scroll: typeof body.scroll === 'string' ? body.scroll : '',
      }
    } catch (error) {
      if (error instanceof ManticoreError) throw error
      const reason = error?.name === 'AbortError' ? 'request timed out' : error?.message
      throw new ManticoreError(`Manticore is unavailable: ${reason}`)
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortRequest)
    }
  }

  async *searchBroad(query, pageSize, { signal, tables }) {
    const options = { sql: true, queryTimeMs: BROAD_QUERY_TIME_MS }
    const queryOptions = `cutoff=0,threads=1,low_priority=1,max_query_time=${BROAD_QUERY_TIME_MS}`
    const match = sqlString(query)
    for (const table of tables) {
      if (!/^matrix_row_\d{4,}(,matrix_row_\d{4,})*$/.test(table)) {
        throw new ManticoreError('Invalid published shard name')
      }
      let after = 0n
      let remaining
      do {
        if (signal?.aborted) return
        const selection = await this.request(
          `SELECT id FROM ${table} WHERE MATCH(${match}) AND id>${after} ORDER BY id ASC LIMIT ${BROAD_ID_WINDOW} ` +
          `OPTION ranker=none,max_matches=${BROAD_ID_WINDOW},${queryOptions}`, signal, options)
        if ((remaining !== undefined && remaining !== selection.total)
          || selection.hits.length !== Math.min(selection.total, BROAD_ID_WINDOW)) {
          throw new ManticoreError('Manticore returned incomplete document IDs')
        }
        const ids = readDocumentIds(selection.hits, after)
        remaining = selection.total - ids.length
        if (ids.length) after = BigInt(ids.at(-1))
        yield { hits: [], tookMs: selection.tookMs }

        for (let index = 0; index < ids.length; index += pageSize) {
          if (signal?.aborted) return
          const batch = ids.slice(index, index + pageSize)
          const page = await this.request(
            `SELECT id, payload FROM ${table} WHERE id IN (${batch.join(',')}) ORDER BY id ASC LIMIT ${batch.length} ` +
            `OPTION max_matches=${batch.length},${queryOptions}`, signal, options)
          if (page.hits.length !== batch.length || page.total !== batch.length
            || page.hits.some((hit, i) => String(hit._id) !== batch[i] || hit._source?.payload == null)) {
            throw new ManticoreError('Manticore did not return all requested documents')
          }
          yield page
        }
      } while (remaining > 0)
    }
  }

  async *searchAll(query, pageSize, { signal } = {}) {
    let scroll = true
    let previousScroll = ''

    while (!signal?.aborted) {
      const payload = {
        table: this.table,
        query: { query_string: query },
        _source: ['payload'],
        limit: pageSize,
        options: {
          max_query_time: this.maxQueryTimeMs,
          scroll,
        },
      }
      if (scroll === true) {
        payload.sort = [{ id: { order: 'asc' } }]
      }

      const page = await this.request(payload, signal)
      yield page

      if (page.hits.length === 0 || page.hits.length < pageSize || !page.scroll) return
      if (page.scroll === previousScroll) {
        throw new ManticoreError('Manticore returned the same scroll token twice')
      }
      previousScroll = page.scroll
      scroll = page.scroll
    }
  }
}
