import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCatalogGuard } from '../node/modules/catalog/guard.mjs'
import { OperationalRepository } from '../node/infrastructure/mysql/repository.mjs'

test('published catalog identities cannot be deleted or reused by operational CRUD', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'matrix-catalog-guard-'))
  try {
    const snapshot = path.join(directory, 'catalog.json')
    await writeFile(snapshot, JSON.stringify({ databases: [{ id: 7, name_table: 'source_7' }] }))
    const queries = []
    const pool = { async execute(sql, params) { queries.push({ sql, params }); return [{ affectedRows: 1 }] } }
    const repo = new OperationalRepository(pool, { catalogGuard: createCatalogGuard(snapshot) })
    await assert.rejects(repo.delete('data_base', '7'), { code: 9 })
    await assert.rejects(repo.create('data_base', { id: '7', name_table: 'other' }), { code: 9 })
    await assert.rejects(repo.create('data_base', { name_table: 'new' }), { code: 9 })
    assert.equal(queries.length, 0)
    assert.deepEqual(await repo.delete('data_base', '8'), { deleted: true })
    assert.deepEqual(await repo.delete('work_items', '7'), { deleted: true })
    await writeFile(snapshot, '{corrupt')
    await assert.rejects(repo.delete('data_base', '8'), { code: 9 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
