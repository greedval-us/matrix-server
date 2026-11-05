#!/usr/bin/env node
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import grpc from '@grpc/grpc-js'
import protoLoader from '@grpc/proto-loader'

const SEARCH_FIELDS = new Set([
  'number', 'mail', 'snils', 'inn', 'passport', 'fio', 'date_of_birth',
  'telegram', 'vk', 'facebook', 'imsi', 'imei', 'grz', 'vin',
])

function parseArgs(argv) {
  const result = {
    endpoint: process.env.MATRIX_GRPC_ENDPOINT ?? '127.0.0.1:50051',
    field: '',
    value: '',
    limit: 10,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (key === '--endpoint' && value) result.endpoint = value
    else if (key === '--field' && value) result.field = value
    else if (key === '--value' && value) result.value = value
    else if (key === '--limit' && value) result.limit = Number.parseInt(value, 10)
    else throw new Error(`Unknown or incomplete argument: ${key}`)
    index += 1
  }
  if (result.field && !SEARCH_FIELDS.has(result.field)) {
    throw new Error(`Unsupported field: ${result.field}`)
  }
  if (Boolean(result.field) !== Boolean(result.value)) {
    throw new Error('--field and --value must be provided together')
  }
  return result
}

function unary(client, method, request, metadata) {
  return new Promise((resolve, reject) => {
    client[method](request, metadata, (error, response) => {
      if (error) reject(error)
      else resolve(response)
    })
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const apiKey = (process.env.MATRIX_API_KEY ?? '').trim()
  if (!apiKey) throw new Error('Set MATRIX_API_KEY before running this check')
  const directory = path.dirname(fileURLToPath(import.meta.url))
  const loaderOptions = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  }
  const searchDefinition = protoLoader.loadSync(
    path.resolve(directory, '../protos/base_search.proto'),
    loaderOptions,
  )
  const databaseDefinition = protoLoader.loadSync(
    path.resolve(directory, '../protos/database_all.proto'),
    loaderOptions,
  )
  const searchPackage = grpc.loadPackageDefinition(searchDefinition).base_search
  const databasePackage = grpc.loadPackageDefinition(databaseDefinition).database_all
  const caPath = (process.env.MATRIX_GRPC_TLS_CA ?? '').trim()
  const credentials = caPath
    ? grpc.credentials.createSsl(await readFile(caPath))
    : grpc.credentials.createInsecure()
  const client = new searchPackage.BaseSearches(args.endpoint, credentials)
  const databaseClient = new databasePackage.DatabaseAll(args.endpoint, credentials)
  const metadata = new grpc.Metadata()
  metadata.set('x-api-key', apiKey)

  const status = await unary(client, 'getIndexStatus', {}, metadata)
  console.log(`[grpc:status] status=${status.status} shards=${status.indexed_shards}/${status.total_shards} progress=${status.progress_percent}%`)
  let databaseCount = 0
  const catalog = databaseClient.streamDatabaseAll({ request: 'catalog' }, metadata)
  await new Promise((resolve, reject) => {
    catalog.on('data', () => { databaseCount += 1 })
    catalog.on('error', reject)
    catalog.on('end', resolve)
  })
  console.log(`[grpc:catalog] databases=${databaseCount}`)
  if (!args.field) {
    client.close()
    databaseClient.close()
    return
  }

  const startedAt = performance.now()
  const stream = client.streamSearch({ [args.field]: args.value, limit: args.limit }, metadata)
  let rows = 0
  let sampleSource = ''
  let sampleFieldCount = 0
  let suggestions = 0
  await new Promise((resolve, reject) => {
    stream.on('data', (message) => {
      if (message.object_data) {
        rows += 1
        if (!sampleSource) {
          sampleSource = message.object_data.source_name
          sampleFieldCount = Object.keys(message.object_data.fields ?? {}).length
        }
      }
      if (message.object_add_search) suggestions += message.object_add_search.item.length
      if (message.meta) {
        console.log(`[grpc:search] hits=${message.meta.total_hits} returned=${message.meta.returned_hits} manticore=${message.meta.took_ms}ms partial=${message.meta.partial}`)
      }
    })
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  console.log(
    `[grpc:complete] rows=${rows} sample_source=${sampleSource || '-'} `
    + `sample_fields=${sampleFieldCount} suggestions=${suggestions} `
    + `elapsed=${Math.round(performance.now() - startedAt)}ms`,
  )
  client.close()
  databaseClient.close()
}

main().catch((error) => {
  console.error(`[grpc:check] ${error.details || error.message}`)
  process.exitCode = 1
})
