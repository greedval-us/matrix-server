import { readFile } from 'node:fs/promises'

export function emptyIndexStatus() {
  return {
    status: 'not_started',
    indexedShards: 0,
    totalShards: 0,
    currentShard: -1,
    progressPercent: 0,
    updatedAt: '',
    partial: true,
  }
}

export async function readIndexStatus(statePath) {
  try {
    const data = JSON.parse(await readFile(statePath, 'utf8'))
    const completed = Array.isArray(data.completed_shards) ? data.completed_shards.length : 0
    const total = Math.max(0, Number.parseInt(data.total_shards ?? 0, 10) || 0)
    const status = String(data.status || 'not_started')
    return {
      status,
      indexedShards: completed,
      totalShards: total,
      currentShard: Number.parseInt(data.current_shard ?? -1, 10),
      progressPercent: total > 0 ? Math.round((completed * 10_000) / total) / 100 : 0,
      updatedAt: String(data.updated_at || ''),
      partial: status !== 'completed' || completed < total,
    }
  } catch {
    return emptyIndexStatus()
  }
}
