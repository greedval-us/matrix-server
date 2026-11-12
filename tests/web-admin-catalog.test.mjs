import assert from 'node:assert/strict'
import test from 'node:test'
import { OperationalRepository } from '../node/infrastructure/mysql/repository.mjs'
import { createCatalogEditor } from '../node/web-admin/catalog.mjs'

function fixture(results = []) {
  const calls = []
  const repository = new OperationalRepository({
    async execute(sql, params = []) {
      calls.push({ sql, params })
      return [results.shift() ?? []]
    },
  })
  return { editor: createCatalogEditor(repository), calls }
}

const row = {
  id: 4294967295, name_table: 'source_one', name: 'Название', info: null,
  relevance_date: null, country: 'RU', type: null, trust: null,
}

test('lists a bounded catalog page with literal search and explicit column grants', async () => {
  const { editor, calls } = fixture([[{ ...row, access_level: 'restricted' }], [{ total: '72' }]])
  const query = "Архив%_'"
  assert.deepEqual(await editor.list({ query, page: 2 }), {
    rows: [{ id: '4294967295', name_table: 'source_one', name: 'Название', country: 'RU', type: null }],
    total: 72, page: 2, pageSize: 50,
  })
  assert.match(calls[0].sql, /ORDER BY `id` LIMIT \? OFFSET \?/)
  assert.match(calls[1].sql, /COUNT\(`id`\)/)
  assert.ok(calls.every(call => !call.sql.includes(query) && !call.sql.includes('access_level')))
  assert.deepEqual(calls[0].params, [query, query, 50, 50])
  assert.deepEqual(calls[1].params, [query, query])
})

test('a numeric search also matches catalog ID', async () => {
  const { editor, calls } = fixture([[], [{ total: '0' }]])
  await editor.list({ query: '4294967295' })
  assert.match(calls[0].sql, /OR `id` = \?/)
  assert.deepEqual(calls[0].params, ['4294967295', '4294967295', '4294967295', 50, 0])
})

test('rejects changes to identities or operational fields before issuing SQL', async () => {
  const { editor, calls } = fixture()
  for (const field of ['id', 'name_table', 'access_level', 'count', 'search_fio', 'created_at', '__proto__']) {
    await assert.rejects(editor.update('1', { name: 'Valid', [field]: 'invalid' }), { code: 3 })
  }
  for (const changes of [null, [], {}, { name: 7 }, { name: '😀'.repeat(256) }, { info: 'я'.repeat(32768) }]) {
    await assert.rejects(editor.update('1', changes), { code: 3 })
  }
  for (const id of ['0', '01', '4294967296', 1, '1 OR 1=1']) {
    await assert.rejects(editor.get(id), { code: 3 })
    await assert.rejects(editor.update(id, { name: 'Valid' }), { code: 3 })
  }
  await assert.rejects(editor.list({ page: 0 }), { code: 3 })
  await assert.rejects(editor.list({ query: 'я'.repeat(256) }), { code: 3 })
  assert.deepEqual(calls, [])
})

test('updates only changed descriptive columns and preserves nulls and identity', async () => {
  const name = '😀'.repeat(255)
  const info = 'я'.repeat(32767) + 'a'
  const { editor, calls } = fixture([{ affectedRows: 1 }, [{ ...row, name, info, country: null, search_fio: 1 }]])
  assert.deepEqual(await editor.update('4294967295', { name, info, country: null }), {
    ...row, id: '4294967295', name, info, country: null,
  })
  assert.equal(calls[0].sql, 'UPDATE `data_base` SET `name` = ?, `info` = ?, `country` = ? WHERE `id` = ?')
  assert.deepEqual(calls[0].params, [name, info, null, '4294967295'])
  assert.deepEqual(calls[1].params, ['4294967295'])
})

test('missing catalog rows map to not found while same-value updates return the row', async () => {
  const { editor } = fixture([[], { affectedRows: 0 }, [], { affectedRows: 0 }, [row]])
  await assert.rejects(editor.get('2'), { code: 5 })
  await assert.rejects(editor.update('2', { info: null }), { code: 5 })
  assert.deepEqual(await editor.update('4294967295', { info: null }), { ...row, id: '4294967295' })
})

test('catalog type registry lists selectable names and normalizes names on insert', async () => {
  const { editor, calls } = fixture([[{ name: 'Магазины и ритейл' }], { affectedRows: 1 }])
  assert.deepEqual(await editor.listTypes(), ['Магазины и ритейл'])
  assert.equal(await editor.createType('  Наука\u00a0\t и образование  '), 'Наука и образование')
  for (const name of ['', ' \t', null, 3, '\u0000', '😀'.repeat(256)]) {
    await assert.rejects(editor.createType(name), { code: 3 })
  }
  assert.match(calls[0].sql, /WHERE `alias_for` IS NULL ORDER BY `name`/)
  assert.match(calls[1].sql, /^INSERT INTO `catalog_types` \(`name`\) VALUES \(\?\)$/)
  assert.deepEqual(calls[1].params, ['Наука и образование'])
  assert.equal(calls.length, 2)
})

test('catalog update writes the registered type spelling and allows clearing the type', async () => {
  const type = 'Магазины и ритейл'
  const { editor, calls } = fixture([[{ name: type }], { affectedRows: 1 }, [{ ...row, type }], { affectedRows: 1 }, [row]])
  const id = '4294967295'
  assert.equal((await editor.update(id, { name: 'Название', type: ' магазины  и ритейл ' })).type, type)
  assert.match(calls[0].sql, /WHERE `name` = \? AND `alias_for` IS NULL/)
  assert.deepEqual(calls[0].params, ['магазины и ритейл'])
  assert.deepEqual(calls[1].params, ['Название', type, id])
  assert.equal((await editor.update(id, { type: null })).type, null)
  assert.deepEqual(calls[3].params, [null, id])
})

test('unregistered or obsolete type names cannot update a catalog row', async () => {
  const { editor, calls } = fixture([[], []])
  await assert.rejects(editor.update('1', { name: 'Other edit', type: 'Unknown category' }), { code: 3 })
  await assert.rejects(editor.update('1', { type: 'Магазины' }), { code: 3 })
  assert.equal(calls.length, 2)
  assert.ok(calls.every(({ sql }) => !sql.startsWith('UPDATE')))
})
