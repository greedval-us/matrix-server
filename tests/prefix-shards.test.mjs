import assert from 'node:assert/strict'
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readPrefixShards } from '../node/modules/search/prefix-shards.mjs'

test('prefix search snapshots only published shards and groups overlapping ID ranges', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'matrix-prefix-plan-'))
  const statePath = path.join(directory, 'indexer.json')
  const planPath = path.join(directory, 'index-plan.json')
  const segment = (database_id, start_id, end_id) => ({ database_id, start_id, end_id })
  const shard = (...segments) => ({ segments })
  try {
    const plan = {
      schema_version: 3, signature: 'new', predecessors: [{ signature: 'previous', shard_count: 3 }],
      shards: [
        shard(segment(1, 1, 50), segment(4, 1, 50)),
        shard(segment(5, 1, 50)),
        shard(segment(3, 1, 50)),
        shard(segment(6, 1, 50)),
      ],
    }
    const state = {
      schema_version: 3, plan_signature: 'previous', status: 'completed',
      total_shards: 3, completed_shards: [0, 1, 2],
    }
    await writeFile(statePath, JSON.stringify(state))
    await writeFile(planPath, JSON.stringify(plan))
    assert.deepEqual(await readPrefixShards(statePath), {
      status: { indexedShards: 3, totalShards: 3, partial: false },
      tables: ['matrix_row_0000,matrix_row_0002', 'matrix_row_0001'],
    })
    await writeFile(statePath, JSON.stringify({ ...state, plan_signature: 'unrelated' }))
    await assert.rejects(readPrefixShards(statePath), /shard information is unavailable/)
  } finally {
    for (const file of [statePath, planPath]) await unlink(file).catch(() => {})
    await rmdir(directory)
  }
})
