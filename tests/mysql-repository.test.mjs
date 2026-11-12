import test from 'node:test'
import assert from 'node:assert/strict'

async function repository(responses = []) {
  const { OperationalRepository } = await import('../node/infrastructure/mysql/repository.mjs')
  const queries = []
  const pool = { async execute(sql, params = []) {
    queries.push({ sql, params })
    const response = responses.shift()
    if (response instanceof Error) throw response
    return [response ?? [], []]
  } }
  return { repo: new OperationalRepository(pool), queries }
}

test('unknown resources, malformed ids and pagination never reach SQL', async () => {
  const { repo, queries } = await repository()
  for (const resource of ['users', 'source.data_base', 'data_base` WHERE 1=1', '__proto__']) {
    await assert.rejects(repo.list(resource), { code: 3 })
  }
  for (const id of ['0', '-1', '1 OR 1=1', '01', '18446744073709551616', 1, '']) {
    await assert.rejects(repo.get('work_items', id), { code: 3 })
  }
  for (const options of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { offset: -1 }, { offset: '2' }]) {
    await assert.rejects(repo.list('work_items', options), { code: 3 })
  }
  assert.equal(queries.length, 0)
})

test('list preserves bigint ids and totals, nulls and JSON map strings', async () => {
  const { repo, queries } = await repository([
    [{ id: '18446744073709551615', namespace: 'cases', name: null, payload: '{"ok":true}' }],
    [{ total: '9007199254740993' }],
  ])
  assert.deepEqual(await repo.list('work_items', { limit: 5, offset: 10 }), {
    rows: [{ id: '18446744073709551615', values: { namespace: 'cases', name: '', payload: '{"ok":true}' } }],
    total: '9007199254740993',
  })
  assert.match(queries[0].sql, /ORDER BY `id` LIMIT \? OFFSET \?/)
  assert.deepEqual(queries[0].params, [5, 10])
})

test('empty writes, unknown columns and readonly logs are rejected before SQL', async () => {
  const { repo, queries } = await repository()
  for (const values of [{}, { sql: 'DROP TABLE data_base' }, { id: '2' }, { payload: 'not json' }, { namespace: 'x'.repeat(129) }]) {
    await assert.rejects(repo.update('work_items', '1', values), { code: 3 })
  }
  await assert.rejects(repo.create('work_items', { name: 'missing namespace' }), { code: 3 })
  for (const method of ['create', 'update', 'delete']) {
    const args = method === 'create' ? ['service_logs', { module: 'search' }] : ['service_logs', '1', { module: 'search' }]
    await assert.rejects(repo[method](...args), { code: 7 })
  }
  assert.equal(queries.length, 0)
})

test('catalog identity is bounded and immutable but explicit import ids are accepted', async () => {
  const { repo, queries } = await repository([{ insertId: '4294967295' }, [{ id: '4294967295', name_table: 'source_1' }]])
  for (const values of [{ name_table: 'db.table' }, { name_table: 'x', id: '4294967296' }]) {
    await assert.rejects(repo.create('data_base', values), { code: 3 })
  }
  for (const values of [{ id: '3' }, { name_table: 'renamed' }]) {
    await assert.rejects(repo.update('data_base', '1', values), { code: 3 })
  }
  const row = await repo.create('data_base', { id: '4294967295', name_table: 'source_1' })
  assert.equal(row.id, '4294967295')
  assert.deepEqual(queries[0].params, ['4294967295', 'source_1'])
})

test('create binds malicious values and reads exact bigint insert id', async () => {
  const value = "Robert'); DROP TABLE work_items;--"
  const { repo, queries } = await repository([{ insertId: '9007199254740993' }, [{ id: '9007199254740993', namespace: 'cases', name: value, payload: '{}' }]])
  assert.equal((await repo.create('work_items', { namespace: 'cases', name: value, payload: '{}' })).id, '9007199254740993')
  assert.ok(!queries[0].sql.includes(value))
  assert.deepEqual(queries[0].params, ['cases', value, '{}'])
  assert.deepEqual(queries[1].params, ['9007199254740993'])
})

test('create handles mysql2 signed insert-id decoding across the full unsigned bigint range', async () => {
  const { repo, queries } = await repository([{ insertId: '-1' }, [{ id: '18446744073709551615', namespace: 'cases', name: 'last' }]])
  assert.equal((await repo.create('work_items', { namespace: 'cases', name: 'last' })).id, '18446744073709551615')
  assert.deepEqual(queries[1].params, ['18446744073709551615'])
})

test('unchanged update returns its row and absent update reports NOT_FOUND', async () => {
  const { repo } = await repository([{ affectedRows: 0 }, [{ id: '9', name: 'same' }], { affectedRows: 0 }, []])
  assert.deepEqual(await repo.update('work_items', '9', { name: 'same' }), { id: '9', values: { name: 'same' } })
  await assert.rejects(repo.update('work_items', '10', { name: 'missing' }), { code: 5 })
})

test('delete distinguishes missing rows and maps duplicate and SQL failures safely', async () => {
  const duplicate = Object.assign(new Error('secret SQL duplicate text'), { code: 'ER_DUP_ENTRY' })
  const { repo } = await repository([{ affectedRows: 1 }, { affectedRows: 0 }, duplicate, new Error('secret password SQL')])
  assert.deepEqual(await repo.delete('work_items', '1'), { deleted: true })
  await assert.rejects(repo.delete('work_items', '1'), { code: 5 })
  await assert.rejects(repo.create('work_items', { namespace: 'cases', name: 'one' }), error => error.code === 6 && !error.message.includes('secret'))
  await assert.rejects(repo.get('data_base', '1'), error => error.code === 14 && !error.message.includes('secret'))
})

test('catalog snapshots retain nullable raw fields and logs only persist safe metadata', async () => {
  const { repo, queries } = await repository([[{ id: 1, info: null, count: '20' }], { insertId: 1 }])
  assert.deepEqual(await repo.catalogRows(), [{ id: 1, info: null, count: '20' }])
  await repo.appendLog({ module: 'search', method: 'Search', statusCode: 0, durationMs: 12, apiKey: 'never-store', query: 'private' })
  assert.deepEqual(queries[1].params, ['search', 'Search', 0, 12])
  assert.ok(!queries[1].sql.includes('apiKey'))
})

test('search metadata selects only descriptive fields for a bound batch of source IDs', async () => {
  const rows = [{ id: 7, name_table: 'source_7', name: 'Название', info: null }]
  const { repo, queries } = await repository([rows])
  assert.deepEqual(await repo.searchSourceMetadata([]), [])
  await assert.rejects(repo.searchSourceMetadata([7, '1 OR 1=1']), { code: 3 })
  assert.equal(queries.length, 0)
  assert.deepEqual(await repo.searchSourceMetadata([7, 9, 7]), rows)
  assert.deepEqual(queries, [{ sql: 'SELECT `id`, `name_table`, `name`, `info` FROM `data_base` WHERE `id` IN (?, ?)', params: ['7', '9'] }])
})
