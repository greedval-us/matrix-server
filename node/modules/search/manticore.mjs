export class ManticoreError extends Error {}

export class ManticoreClient {
  constructor({ baseUrl, table, maxQueryTimeMs, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl
    this.table = table
    this.maxQueryTimeMs = maxQueryTimeMs
    this.fetch = fetchImpl
  }

  async request(payload, signal) {
    const controller = new AbortController()
    const abortRequest = () => controller.abort(signal?.reason)
    if (signal?.aborted) abortRequest()
    else signal?.addEventListener('abort', abortRequest, { once: true })
    const timeout = setTimeout(() => controller.abort(), this.maxQueryTimeMs + 5000)

    try {
      const response = await this.fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new ManticoreError(`Manticore returned HTTP ${response.status}: ${text.slice(0, 500)}`)
      }
      let body
      try {
        body = JSON.parse(text)
      } catch (error) {
        throw new ManticoreError(`Manticore returned invalid JSON: ${error.message}`)
      }
      if (body.error) {
        throw new ManticoreError(`Manticore search failed: ${String(body.error).slice(0, 500)}`)
      }
      const hitsNode = body.hits ?? {}
      const totalNode = hitsNode.total ?? 0
      const total = Number(typeof totalNode === 'object' ? totalNode.value ?? 0 : totalNode)
      return {
        hits: Array.isArray(hitsNode.hits) ? hitsNode.hits : [],
        total: Number.isFinite(total) ? total : 0,
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
