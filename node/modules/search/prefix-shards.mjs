import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { emptyIndexStatus } from './index-state.mjs'
import { ManticoreError } from './manticore.mjs'

const MAX_COMPONENT_ID = 0xffffffff
const isComponentId = id => Number.isInteger(id) && id > 0 && id <= MAX_COMPONENT_ID

function rangeForShard(shard, index) {
  if (!Array.isArray(shard?.segments) || shard.segments.length === 0) throw new Error('Missing segments')
  let minimum
  let maximum
  for (const { database_id: databaseId, start_id: start, end_id: end } of shard.segments) {
    if (![databaseId, start, end].every(isComponentId) || end < start) throw new Error('Invalid segment')
    const base = BigInt(databaseId) << 32n
    const lower = base + BigInt(start)
    const upper = base + BigInt(end)
    if (minimum === undefined || lower < minimum) minimum = lower
    if (maximum === undefined || upper > maximum) maximum = upper
  }
  return { minimum, maximum, table: `matrix_row_${String(index).padStart(4, '0')}` }
}

export async function readPrefixShards(statePath) {
  try {
    let checkpoint
    try { checkpoint = JSON.parse(await readFile(statePath, 'utf8')) }
    catch (error) {
      if (error?.code === 'ENOENT') return { status: emptyIndexStatus(), tables: [] }
      throw error
    }
    const { completed_shards: published, total_shards: total } = checkpoint
    if (!Array.isArray(published) || !Number.isSafeInteger(total) || total < 0
      || new Set(published).size !== published.length
      || published.some(index => !Number.isSafeInteger(index) || index < 0 || index >= total)) {
      throw new Error('Invalid checkpoint')
    }
    const status = {
      indexedShards: published.length,
      totalShards: total,
      partial: checkpoint.status !== 'completed' || published.length < total,
    }
    if (published.length === 0) return { status, tables: [] }

    // The indexer publishes an expanded plan before advancing its checkpoint.
    const plan = JSON.parse(await readFile(path.join(path.dirname(statePath), 'index-plan.json'), 'utf8'))
    const current = plan.signature === checkpoint.plan_signature && plan.shards?.length === total
    const predecessor = Array.isArray(plan.predecessors) && plan.predecessors.some(entry =>
      entry.signature === checkpoint.plan_signature && entry.shard_count === total)
    if (plan.schema_version !== checkpoint.schema_version || !checkpoint.plan_signature
      || !Array.isArray(plan.shards) || plan.shards.length < total || (!current && !predecessor)) {
      throw new Error('Plan does not match checkpoint')
    }
    const ranges = published.map(index => rangeForShard(plan.shards[index], index))
    ranges.sort((a, b) => a.minimum < b.minimum ? -1 : a.minimum > b.minimum ? 1 : 0)
    const tables = []
    let maximum = 0n
    for (const range of ranges) {
      if (range.minimum <= maximum) tables[tables.length - 1] += `,${range.table}`
      else tables.push(range.table)
      if (range.maximum > maximum) maximum = range.maximum
    }
    return { status, tables }
  } catch (error) {
    throw new ManticoreError('Published search shard information is unavailable', { cause: error })
  }
}
