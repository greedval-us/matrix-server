import { APPLICATION_ERROR_CODES, ApplicationError } from '../../core/errors.mjs'
import { readDatabaseCatalog } from '../catalog/catalog.mjs'
import { decodeDocumentId, parseStoredFields } from './documents.mjs'
import { readIndexStatus } from './index-state.mjs'
import { ManticoreClient, ManticoreError } from './manticore.mjs'
import { InvalidSearchQuery, SEARCH_FIELDS, buildManticoreQuery } from './normalization.mjs'

const MAX_SEARCH_PAGE_SIZE = 10_000
const MAX_SEARCH_SUGGESTIONS = 50

export class SearchCapacity {
  constructor(limit) {
    this.limit = limit
    this.active = 0
  }

  acquire() {
    if (this.active >= this.limit) {
      throw new ApplicationError(APPLICATION_ERROR_CODES.RESOURCE_EXHAUSTED, 'Too many concurrent searches')
    }
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active -= 1
    }
  }

  async run(action) {
    const release = this.acquire()
    try { return await action() }
    finally { release() }
  }
}

export class SearchService {
  constructor(settings, { manticore, readCatalog = readDatabaseCatalog, readStatus = readIndexStatus,
    readSourceMetadata, readFieldLabels } = {}) {
    this.settings = settings
    this.readCatalog = readCatalog
    this.readStatus = readStatus
    this.readSourceMetadata = readSourceMetadata
    this.readFieldLabels = readFieldLabels
    this.capacity = new SearchCapacity(settings.maxConcurrentSearches)
    this.manticore = manticore ?? new ManticoreClient({
      baseUrl: settings.manticoreUrl,
      table: settings.manticoreTable,
      maxQueryTimeMs: settings.maxQueryTimeMs,
    })
  }

  async *search(request, { signal } = {}) {
    if (signal?.aborted) return
    try {
      const values = Object.fromEntries(
        SEARCH_FIELDS.filter(field => request[field]).map(field => [field, request[field]]),
      )
      const { expression, normalized } = buildManticoreQuery(values)
      const requestedPageSize = Number.parseInt(request.limit ?? 0, 10) || this.settings.searchPageSize
      const pageSize = Math.min(Math.max(requestedPageSize, 1), MAX_SEARCH_PAGE_SIZE)
      const status = await this.readStatus(this.settings.indexStatePath)
      const catalog = await this.readCatalog(this.settings.databaseCatalogPath)
      if (signal?.aborted) return
      const requested = new Map(normalized.map(query => [query.field, query.pattern.toLocaleLowerCase()]))
      const sentSources = new Set()
      const suggestions = new Map()
      let returned = 0
      let total = 0
      let tookMs = 0
      let firstPage = true
      let readSourceMetadata = this.readSourceMetadata
      const release = this.capacity.acquire()
      try {
        for await (const response of this.manticore.searchAll(expression, pageSize, { signal })) {
          if (signal?.aborted) return
          if (firstPage) {
            total = response.total
            firstPage = false
          }
          tookMs += response.tookMs
          const sourceIds = new Set()
          const hits = response.hits.map(hit => {
            const { databaseId, rowId } = decodeDocumentId(hit._id)
            const database = catalog.byId.get(databaseId)
            if (!database) throw new Error(`Database ${databaseId} is missing from the catalog`)
            if (readSourceMetadata && !sentSources.has(database.search.name_table)) sourceIds.add(databaseId)
            return { hit, databaseId, rowId, published: database.search }
          })
          let liveSources
          if (sourceIds.size) {
            try {
              const rows = await readSourceMetadata([...sourceIds])
              liveSources = new Map(rows.map(row => [String(row.id), row]))
            } catch (error) {
              if (error?.code !== APPLICATION_ERROR_CODES.UNAVAILABLE) throw error
              readSourceMetadata = undefined
            }
          }
          for (const { hit, databaseId, rowId, published } of hits) {
            if (signal?.aborted) return
            const sourceName = published.name_table
            if (!sentSources.has(sourceName)) {
              sentSources.add(sourceName)
              const current = liveSources?.get(String(databaseId))
              const metadata = current && current.name_table === sourceName
                ? { ...published, name: String(current.name ?? ''), info: String(current.info ?? '') }
                : published
              const source = { object_data_base: metadata }
              if (sentSources.size === 1 && this.readFieldLabels) {
                try {
                  const rows = await this.readFieldLabels()
                  if (rows.length) source.field_labels = Object.fromEntries(rows.map(({ field_key, label }) => [field_key, label]))
                } catch (error) {
                  if (error?.code !== APPLICATION_ERROR_CODES.UNAVAILABLE) throw error
                }
                if (signal?.aborted) return
              }
              yield source
              if (signal?.aborted) return
            }
            const fields = parseStoredFields(hit._source?.payload)
            if (!Object.hasOwn(fields, 'id')) fields.id = rowId
            yield { object_data: { source_name: sourceName, fields } }
            if (signal?.aborted) return
            returned += 1
            for (const field of SEARCH_FIELDS) {
              const value = String(fields[field] || '').trim()
              if (!value || suggestions.size >= MAX_SEARCH_SUGGESTIONS) continue
              if (value.toLocaleLowerCase() !== requested.get(field)) {
                suggestions.set(`${field}\u0000${value}`, { key: field, value })
              }
            }
          }
        }
      } finally { release() }

      if (signal?.aborted) return
      if (suggestions.size > 0) yield { object_add_search: { item: [...suggestions.values()] } }
      if (signal?.aborted) return
      yield {
        meta: {
          total_hits: String(total), returned_hits: String(returned),
          indexed_shards: status.indexedShards, total_shards: status.totalShards,
          partial: status.partial, took_ms: tookMs,
        },
      }
    } catch (error) {
      if (signal?.aborted) return
      if (error instanceof InvalidSearchQuery) throw new ApplicationError(APPLICATION_ERROR_CODES.INVALID_ARGUMENT, error.message)
      if (error instanceof ManticoreError) throw new ApplicationError(APPLICATION_ERROR_CODES.UNAVAILABLE, error.message)
      throw error
    }
  }

  async indexStatus() {
    const status = await this.readStatus(this.settings.indexStatePath)
    return {
      status: status.status,
      indexed_shards: status.indexedShards,
      total_shards: status.totalShards,
      current_shard: status.currentShard,
      progress_percent: status.progressPercent,
      updated_at: status.updatedAt,
    }
  }
}
