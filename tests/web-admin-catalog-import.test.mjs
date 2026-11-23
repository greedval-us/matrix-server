import assert from 'node:assert/strict'
import test from 'node:test'
import { createCatalogImporter } from '../node/web-admin/catalog-import.mjs'

function fixture({ rejectId = false, failCommit = false, reserved = false } = {}) {
  const operations = []
  const stored = []
  const labels = new Map([['number', 'Номер']])
  let values, dropped = false, committed = false
  const connection = {
    async beginTransaction() { operations.push('begin') },
    async execute(sql, params) {
      if (sql.includes('INSERT INTO `data_base`')) {
        const fields = Array.from(sql.matchAll(/`([a-z_]+)`/g), match => match[1]).slice(1)
        values = Object.fromEntries(fields.map((key, index) => [key, params[index]]))
        return [{ insertId: values.id || 27 }]
      }
      if (sql.includes('ORDER BY `id` DESC')) return [[{ id: 55 }]]
      if (sql.includes('INSERT IGNORE INTO `search_field_labels`')) {
        let affectedRows = 0
        for (let i = 0; i < params.length; i += 2) {
          if (!labels.has(params[i])) {
            labels.set(params[i], params[i + 1])
            affectedRows++
          }
        }
        return [{ affectedRows }]
      }
      throw Error(sql)
    },
    async rollback() { operations.push('rollback') },
    async commit() {
      if (failCommit) throw Error('lost reply')
      committed = true
    },
    release() {}, destroy() {},
  }
  const sourcePool = { async execute(sql, params) {
    if (sql.startsWith('CREATE TABLE')) operations.push('create')
    else if (sql.startsWith('DROP TABLE')) dropped = true
    else if (sql.startsWith('INSERT INTO')) stored.push(...params)
    else throw Error(sql)
    return [{}]
  } }
  return {
    run: createCatalogImporter({ sourcePool, pool: { getConnection: async () => connection },
      catalogGuard: async ({ id }) => {
        assert.ok(id === '27' || id === '56')
        if (rejectId) throw Error('reserved identity')
        if (reserved && id === '27') return '40'
      },
    }),
    state: () => ({ operations, stored, labels, values, dropped, committed }),
  }
}

test('publishes metadata, search flags and distinct field labels for the entire folder', async () => {
  const { run, state } = fixture()
  const original = '{"number":12345678901234567890,"новый ключ":{"x":1},"id":"original"}'
  const result = await run({ name: 'База', access_level: '1' }, [
    { name: 'a.json', records: ['{}', original] },
    { name: 'b.json', records: ['{"mail":"a@example.test","новый ключ":false}'] },
  ])
  assert.match(result.row.name_table, /^json_import_[a-f0-9]{32}$/)
  assert.deepEqual({ ...result, row: result.row.id }, { row: '27', rows: 3, files: 2, newFields: 3 })
  assert.ok(state().committed)
  assert.equal(state().stored[1], original)
  assert.equal(state().values.count, 3)
  assert.equal(state().values.access_level, '1')
  assert.equal(state().values.search_number, 1)
  assert.equal(state().values.search_mail, 1)
  assert.equal(state().values.search_vk, 0)
  assert.equal(state().labels.get('number'), 'Номер')
  assert.equal(state().labels.get('новый ключ'), 'новый ключ')
})

test('rejects an invalid second file and removes the unpublished table', async () => {
  for (const records of [[], ['{"mail":"  ","number":{},"fio":null}'], ['{"mail":"a","":1}']]) {
    const { run, state } = fixture()
    await assert.rejects(run({ name: 'База' }, [{ name: 'ok.json', records: ['{"mail":"a"}'] },
      { name: 'invalid.json', records }]), { code: 3 })
    assert.ok(state().dropped)
    assert.equal(state().committed, false)
  }
})

test('rejects missing name and client-supplied operational fields before allocating a table', async () => {
  const { run, state } = fixture()
  for (const metadata of [{}, { name: '  ' }, { name: 'Valid', name_table: 'mine' }]) {
    await assert.rejects(run(metadata, []), { code: 3 })
  }
  assert.deepEqual(state().operations, [])
})

test('rolls back a reserved catalogue identity, retaining the table only for an uncertain commit', async () => {
  for (const failCommit of [false, true]) {
    const { run, state } = fixture({ rejectId: !failCommit, failCommit })
    await assert.rejects(run({ name: 'База' }, [{ name: 'file.json', records: ['{"number":"12"}'] }]))
    assert.equal(state().dropped, !failCommit)
    if (!failCommit) assert.ok(state().operations.includes('rollback'))
  }
})

test('repeated request IDs cannot adopt or drop the existing table', async () => {
  const sql = []
  const run = createCatalogImporter({ pool: {}, sourcePool: {
    async execute(query) {
      sql.push(query)
      throw Object.assign(Error('table exists'), { code: 'ER_TABLE_EXISTS_ERROR' })
    },
  } })
  const id = '12345678-5678-4abc-9abc-123456789abc'
  await assert.rejects(run({ name: 'База' }, [], id), { code: 6 })
  assert.equal(sql.length, 1)
  assert.match(sql[0], /^CREATE TABLE `json_import_1234567856784abc9abc123456789abc`/)
  await assert.rejects(run({ name: 'База' }, [], 'invalid'), { code: 3 })
  assert.equal(sql.length, 1)
})

test('a restored catalogue skips retired identities without reading the upload twice', async () => {
  const { run, state } = fixture({ reserved: true })
  const { row } = await run({ name: 'База' }, [{ name: 'file.json', records: ['{"number":"27"}'] }])
  assert.equal(row.id, '56')
  assert.deepEqual(state().stored, ['{"number":"27"}'])
  assert.ok(state().committed)
})
