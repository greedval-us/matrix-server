import { createHash, timingSafeEqual } from 'node:crypto'
import grpc from '@grpc/grpc-js'
import { toRpcError } from '../../core/errors.mjs'

import { readDatabaseCatalog } from '../catalog/catalog.mjs'
import { decodeDocumentId, parseStoredFields } from './documents.mjs'
import { readIndexStatus } from './index-state.mjs'
import { ManticoreClient, ManticoreError } from './manticore.mjs'
import {
  InvalidSearchQuery,
  SEARCH_FIELDS,
  buildManticoreQuery,
} from './normalization.mjs'

function apiKeyDigest(value) {
  return createHash('sha256').update(String(value)).digest()
}

function serviceError(code, details) {
  return Object.assign(new Error(details), { code, details })
}

function failStream(call, error) {
  call.emit('error', toRpcError(error))
}

async function writeStream(call, message) {
  if (call.cancelled || call.destroyed) return false
  if (call.write(message)) return true

  await new Promise((resolve) => {
    const finish = () => {
      call.off('drain', finish)
      call.off('cancelled', finish)
      resolve()
    }
    call.once('drain', finish)
    call.once('cancelled', finish)
  })
  return !call.cancelled && !call.destroyed
}

export class SearchCapacity {
  constructor(limit) {
    this.limit = limit
    this.active = 0
  }

  async run(action) {
    if (this.active >= this.limit) {
      throw serviceError(grpc.status.RESOURCE_EXHAUSTED, 'Too many concurrent searches')
    }
    this.active += 1
    try {
      return await action()
    } finally {
      this.active -= 1
    }
  }
}

export class MatrixSearchService {
  constructor(settings, { requireSharedKey = true } = {}) {
    this.settings = settings
    this.expectedApiKey = requireSharedKey ? apiKeyDigest(settings.apiKey) : null
    this.capacity = new SearchCapacity(settings.maxConcurrentSearches)
    this.manticore = new ManticoreClient({
      baseUrl: settings.manticoreUrl,
      table: settings.manticoreTable,
      maxQueryTimeMs: settings.maxQueryTimeMs,
    })
  }

  authorize(call) {
    if (!this.expectedApiKey) return
    const supplied = call.metadata.get('x-api-key')[0] ?? ''
    if (!timingSafeEqual(apiKeyDigest(supplied), this.expectedApiKey)) {
      throw serviceError(grpc.status.UNAUTHENTICATED, 'Invalid API key')
    }
  }

  async streamSearch(call) {
    try {
      this.authorize(call)
      const values = Object.fromEntries(
        SEARCH_FIELDS.filter((field) => call.request[field]).map((field) => [field, call.request[field]]),
      )
      const { expression, normalized } = buildManticoreQuery(values)
      const requestedPageSize = Number.parseInt(call.request.limit ?? 0, 10)
        || this.settings.searchPageSize
      const pageSize = Math.min(Math.max(requestedPageSize, 1), 10_000)
      const status = await readIndexStatus(this.settings.indexStatePath)
      const catalog = await readDatabaseCatalog(this.settings.databaseCatalogPath)
      const requested = new Map(normalized.map((query) => [
        query.field,
        query.pattern.toLocaleLowerCase(),
      ]))
      const sentSources = new Set()
      const suggestions = new Map()
      let returned = 0
      let total = 0
      let tookMs = 0
      let firstPage = true
      const abortController = new AbortController()
      const cancel = () => abortController.abort()
      call.once('cancelled', cancel)

      try {
        try {
          await this.capacity.run(async () => {
            for await (const response of this.manticore.searchAll(expression, pageSize, {
              signal: abortController.signal,
            })) {
              if (firstPage) {
                total = response.total
                firstPage = false
              }
              tookMs += response.tookMs

              for (const hit of response.hits) {
                if (call.cancelled || call.destroyed) return
                const source = hit._source ?? {}
                const { databaseId, rowId } = decodeDocumentId(hit._id)
                const database = catalog.byId.get(databaseId)
                if (!database) {
                  throw new Error(`Database ${databaseId} is missing from the catalog`)
                }
                const sourceName = database.search.name_table
                if (!sentSources.has(sourceName)) {
                  sentSources.add(sourceName)
                  const written = await writeStream(call, {
                    object_data_base: database.search,
                  })
                  if (!written) return
                }
                const fields = parseStoredFields(source.payload)
                if (!Object.hasOwn(fields, 'id')) fields.id = rowId
                if (!await writeStream(call, { object_data: { source_name: sourceName, fields } })) {
                  return
                }
                returned += 1

                for (const field of SEARCH_FIELDS) {
                  const value = String(fields[field] || '').trim()
                  if (!value || suggestions.size >= 50) continue
                  const normalizedValue = value.toLocaleLowerCase()
                  if (normalizedValue !== requested.get(field)) {
                    suggestions.set(`${field}\u0000${value}`, { key: field, value })
                  }
                }
              }
            }
          })
        } catch (error) {
          if (call.cancelled || abortController.signal.aborted) return
          throw error
        }
      } finally {
        call.off('cancelled', cancel)
      }

      if (call.cancelled || call.destroyed) return

      if (suggestions.size > 0) {
        if (!await writeStream(call, {
          object_add_search: { item: [...suggestions.values()] },
        })) return
      }
      if (!await writeStream(call, {
        meta: {
          total_hits: String(total),
          returned_hits: String(returned),
          indexed_shards: status.indexedShards,
          total_shards: status.totalShards,
          partial: status.partial,
          took_ms: tookMs,
        },
      })) return
      call.end()
    } catch (error) {
      if (error instanceof InvalidSearchQuery) {
        failStream(call, serviceError(grpc.status.INVALID_ARGUMENT, error.message))
        return
      }
      if (error instanceof ManticoreError) {
        failStream(call, serviceError(grpc.status.UNAVAILABLE, error.message))
        return
      }
      failStream(call, error?.code ? error : serviceError(grpc.status.INTERNAL, 'Search failed'))
    }
  }

  async getIndexStatus(call, callback) {
    try {
      this.authorize(call)
      const status = await readIndexStatus(this.settings.indexStatePath)
      callback(null, {
        status: status.status,
        indexed_shards: status.indexedShards,
        total_shards: status.totalShards,
        current_shard: status.currentShard,
        progress_percent: status.progressPercent,
        updated_at: status.updatedAt,
      })
    } catch (error) {
      callback(error?.code ? error : serviceError(grpc.status.INTERNAL, 'Status request failed'))
    }
  }

  async streamDatabaseAll(call) {
    try {
      this.authorize(call)
      const catalog = await readDatabaseCatalog(this.settings.databaseCatalogPath)
      for (const database of catalog.databases) {
        if (!await writeStream(call, database.list)) return
      }
      call.end()
    } catch (error) {
      failStream(call, error?.code ? error : serviceError(grpc.status.INTERNAL, 'Database list failed'))
    }
  }
}
