import test from 'node:test'
import assert from 'node:assert/strict'

const FILE_A = { id: '11111111-1111-4111-8111-111111111111', name: 'акт.pdf', size: '25', mime_type: 'application/pdf' }
const FILE_B = { id: '22222222-2222-4222-8222-222222222222', name: 'scan.txt', size: '0', mime_type: 'text/plain' }
const rawRow = (overrides = {}) => ({ id: '9007199254740993', date: '2026-11-05', number: '+007', fio: 'Иванов И.И.',
  date_of_birth: null, initiator: 'Заявитель', executor: 'Оператор', note: null, realization: '', intersections: '', files: '[]', ...overrides })

// Only the external MySQL boundary is doubled: SQL, bound parameters and transaction
// ownership are observable outputs of the real repository.
async function repository(responses = [], failures = {}) {
  const { ControlRepository } = await import('../node/modules/records/repository.mjs')
  const calls = []
  async function execute(sql, params = [], source = 'pool') {
    calls.push({ sql, params, source })
    const response = responses.shift()
    if (response instanceof Error) throw response
    return [response ?? [], []]
  }
  const connection = {
    execute(sql, params) { return execute(sql, params, 'connection') },
    async beginTransaction() { calls.push({ action: 'begin' }); if (failures.begin) throw failures.begin },
    async commit() { calls.push({ action: 'commit' }); if (failures.commit) throw failures.commit },
    async rollback() { calls.push({ action: 'rollback' }); if (failures.rollback) throw failures.rollback },
    destroy() { calls.push({ action: 'destroy' }) },
    release() { calls.push({ action: 'release' }) },
  }
  const pool = { execute, async getConnection() { calls.push({ action: 'acquire' }); if (failures.acquire) throw failures.acquire; return connection } }
  return { repo: new ControlRepository(pool), calls }
}

test('list returns all explicit display fields and independent attachment metadata without bigint loss', async () => {
  const { repo, calls } = await repository([[rawRow({ source_id: '0007', date_of_birth: 'около 1990 г.',
    group_chat_locality: 'Группа', files: JSON.stringify([FILE_A]) })], [{ total: '9007199254740995' }]])
  const page = await repo.list({})
  assert.deepEqual(page.columns, [
    { key: 'date', label: 'Дата', type: 'date', sortable: true },
    { key: 'id', label: 'ID', type: 'text', sortable: true },
    { key: 'source_id', label: 'Telegram ID', type: 'text', sortable: true },
    { key: 'number', label: 'Номер', type: 'text', sortable: true },
    { key: 'fio', label: 'ФИО', type: 'text', sortable: true },
    { key: 'date_of_birth', label: 'Дата рождения', type: 'text', sortable: true },
    { key: 'group_chat_locality', label: 'Группа, чат, н.п.', type: 'text', sortable: true },
    { key: 'initiator', label: 'Инициатор', type: 'text', sortable: true },
    { key: 'executor', label: 'Исполнитель', type: 'text', sortable: true },
    { key: 'note', label: 'Примечание', type: 'text', sortable: true },
    { key: 'realization', label: 'Реализация', type: 'text', sortable: true },
    { key: 'intersections', label: 'Пересечения', type: 'text', sortable: true },
  ])
  assert.deepEqual(page.rows, [{ id: '9007199254740993', values: { date: '2026-11-05', id: '9007199254740993',
    source_id: '0007', number: '+007', fio: 'Иванов И.И.', date_of_birth: 'около 1990 г.',
    group_chat_locality: 'Группа', initiator: 'Заявитель', executor: 'Оператор', note: '', realization: '', intersections: '' }, files: [FILE_A] }])
  assert.equal(page.total, '9007199254740995')
  assert.match(calls[0].sql, /ORDER BY `date` DESC, `id` DESC LIMIT \? OFFSET \?$/)
  assert.deepEqual(calls[0].params, [100, 0])
})

test('literal global search covers every display field before sorting and paging and reuses its filter for count', async () => {
  const query = "50%_=' OR 1=1"
  const { repo, calls } = await repository([[], [{ total: '0' }]])
  await repo.list({ query, sort_key: 'initiator', sort_direction: 'asc', page: 3, page_size: 20 })
  const [select, count] = calls
  assert.ok(!select.sql.includes(query))
  for (const field of ['date', 'id', 'source_id', 'number', 'fio', 'date_of_birth', 'group_chat_locality',
    'initiator', 'executor', 'note', 'realization', 'intersections']) {
    assert.match(select.sql.slice(select.sql.indexOf(' WHERE ')), new RegExp('`' + field + '`[^?]*LIKE \\?'))
  }
  assert.match(select.sql, /WHERE .* ORDER BY `initiator` ASC, `id` ASC LIMIT \? OFFSET \?$/)
  assert.deepEqual(select.params, [...Array(12).fill("%50=%=_==' OR 1==1%"), 20, 40])
  assert.deepEqual(count.params, Array(12).fill("%50=%=_==' OR 1==1%"))
  assert.equal(select.sql.split(' WHERE ')[1].split(' ORDER BY ')[0], count.sql.split(' WHERE ')[1])
  assert.equal((select.sql.match(/ESCAPE '='/g) ?? []).length, 12)
})

test('proto defaults select the first page and ID sort has no contradictory tiebreaker', async () => {
  const { repo, calls } = await repository([[], [{ total: '0' }], [], [{ total: '0' }]])
  await repo.list({ query: '', sort_key: '', sort_direction: '', page: 0, page_size: 0 })
  await repo.list({ sort_key: 'id', sort_direction: 'desc', page: 1, page_size: 1 })
  assert.deepEqual(calls[0].params, [100, 0])
  assert.match(calls[2].sql, /ORDER BY `id` DESC LIMIT \? OFFSET \?$/)
})

test('malformed IDs, sort and page options never reach MySQL', async () => {
  const { repo, calls } = await repository()
  for (const id of ['0', '-1', '01', '18446744073709551616', '1 OR 1=1', 1, '', null]) {
    for (const method of ['get', 'delete']) await assert.rejects(repo[method](id), { code: 3 })
    await assert.rejects(repo.update(id, { note: 'x' }), { code: 3 })
  }
  for (const request of [null, [], { sort_key: 'files' }, { sort_key: 'id DESC;--' }, { sort_key: '__proto__' },
    { sort_direction: 'drop' }, { page: -1 }, { page: 1.5 }, { page: '1' }, { page_size: 1001 },
    { page_size: -1 }, { query: 9 }, { query: 'x'.repeat(4097) }]) {
    await assert.rejects(repo.list(request), { code: 3 })
  }
  assert.equal(calls.length, 0)
})

test('row CRUD binds text and preserves unsigned bigint generated IDs', async () => {
  const note = "Robert'); DROP TABLE control;--"
  const { repo, calls } = await repository([{ insertId: '-1' }, [rawRow({ id: '18446744073709551615', note })],
    { affectedRows: 0 }, [rawRow({ id: '18446744073709551615', note })]])
  const created = await repo.create({ number: '+007', note })
  assert.equal(created.id, '18446744073709551615')
  assert.ok(!calls[0].sql.includes(note))
  assert.deepEqual(calls[0].params, ['+007', note])
  assert.deepEqual(calls[1].params, ['18446744073709551615'])
  assert.equal((await repo.update('18446744073709551615', { note })).values.note, note)
  assert.deepEqual(calls[2].params, [note, '18446744073709551615'])
})

test('initiator is optional, roundtrips as plain text and can be cleared without changing executor', async () => {
  const initiator = "Заявитель'); DROP TABLE control;--"
  const { repo, calls } = await repository([{ insertId: '1' }, [rawRow({ id: '1', initiator })],
    { affectedRows: 1 }, [rawRow({ id: '1', initiator: '' })], [rawRow({ id: '2', initiator: null })]])
  const created = await repo.create({ initiator, executor: 'Оператор' })
  assert.equal(created.values.initiator, initiator)
  assert.equal(created.values.executor, 'Оператор')
  assert.equal(calls[0].sql, 'INSERT INTO `control` (`initiator`, `executor`) VALUES (?, ?)')
  assert.deepEqual(calls[0].params, [initiator, 'Оператор'])
  assert.match(calls[1].sql, /`date_of_birth`, `group_chat_locality`, `initiator`, `executor`/)
  const cleared = await repo.update('1', { initiator: '' })
  assert.equal(cleared.values.initiator, '')
  assert.equal(cleared.values.executor, 'Оператор')
  assert.equal(calls[2].sql, 'UPDATE `control` SET `initiator` = ? WHERE `id` = ?')
  assert.deepEqual(calls[2].params, ['', '1'])
  assert.equal((await repo.get('2')).values.initiator, '')
})

test('Telegram ID, plain-text birth date and locality are writable without changing record IDs or files', async () => {
  const fields = { source_id: '0007', date_of_birth: 'около 1990 г.', group_chat_locality: 'Группа' }
  const id = '9007199254740993'
  const { repo, calls } = await repository([{ affectedRows: 1 }, [rawRow({ ...fields, files: [FILE_A] })]])
  const saved = await repo.update(id, fields)
  assert.equal(saved.id, id)
  assert.deepEqual(saved.files, [FILE_A])
  for (const [key, value] of Object.entries(fields)) assert.equal(saved.values[key], value)
  assert.match(calls[0].sql, /^UPDATE `control` SET `source_id` = \?, `date_of_birth` = \?, `group_chat_locality` = \? WHERE `id` = \?$/)
  assert.deepEqual(calls[0].params, [...Object.values(fields), id])
})

test('empty create relies on database date defaults while a blank record date binds NULL', async () => {
  const { repo, calls } = await repository([{ insertId: '1' }, [rawRow({ id: '1' })],
    { insertId: '2' }, [rawRow({ id: '2', date: null })]])
  await repo.create({})
  assert.match(calls[0].sql, /^INSERT INTO `control` \(\) VALUES \(\)$/)
  assert.deepEqual(calls[0].params, [])
  await repo.create({ date: '', date_of_birth: '' })
  assert.deepEqual(calls[2].params, [null, ''])
})

test('writes reject immutable fields, nonstrings, impossible calendar dates and byte or character overflow', async () => {
  const { repo, calls } = await repository()
  const invalid = [{ id: '1' }, { files: '[]' }, { unknown: '' }, { note: null }, { number: 'x'.repeat(65) },
    { fio: '😀'.repeat(256) }, { initiator: '😀'.repeat(256) }, { initiator: null }, { executor: 'я'.repeat(256) }, { note: 'я'.repeat(32768) },
    { realization: 'x'.repeat(65536) }, { intersections: '😀'.repeat(16384) },
    { birth_date_text: '' }, { date_of_birth: 'я'.repeat(32768) },
    ...['2025-02-29', '2024-04-31', '0999-01-01', '2024-2-03', '0000-00-00', '2024-01-01T00:00:00Z'].map(date => ({ date }))]
  for (const values of invalid) {
    await assert.rejects(repo.create(values), { code: 3 })
    await assert.rejects(repo.update('1', values), { code: 3 })
  }
  await assert.rejects(repo.update('1', {}), { code: 3 })
  assert.equal(calls.length, 0)
})

test('valid leap dates, astral varchar boundaries and maximum TEXT bytes are accepted', async () => {
  const { repo, calls } = await repository([{ insertId: '3' }, [rawRow({ id: '3' })]])
  await repo.create({ date: '2000-02-29', date_of_birth: '😀'.repeat(16383) + 'abc', number: '😀'.repeat(64),
    fio: '😀'.repeat(255), initiator: '😀'.repeat(255), executor: 'я'.repeat(255), note: 'x'.repeat(65535) })
  assert.equal(calls[0].params[0], '2000-02-29')
  assert.equal(Buffer.byteLength(calls[0].params[1], 'utf8'), 65535)
  assert.equal(calls[0].params[3], '😀'.repeat(255))
  assert.equal(calls[0].params[4], '😀'.repeat(255))
})

test('get and update report absent rows and SQL errors never expose SQL or credentials', async () => {
  const duplicate = Object.assign(new Error('secret duplicate query'), { code: 'ER_DUP_ENTRY' })
  const { repo } = await repository([[], { affectedRows: 0 }, [], duplicate, new Error('secret password query')])
  await assert.rejects(repo.get('1'), { code: 5 })
  await assert.rejects(repo.update('1', { note: 'x' }), { code: 5 })
  await assert.rejects(repo.create({ fio: 'x' }), error => error.code === 6 && !error.message.includes('secret'))
  await assert.rejects(repo.get('1'), error => error.code === 14 && !error.message.includes('secret'))
})

test('adding attachments locks metadata then atomically appends and commits before releasing', async () => {
  const { repo, calls } = await repository([[{ files: JSON.stringify([FILE_A]) }], { affectedRows: 1 }])
  assert.deepEqual(await repo.addFiles('1', [FILE_B]), [FILE_B])
  assert.deepEqual(calls.filter(call => call.action).map(call => call.action), ['acquire', 'begin', 'commit', 'release'])
  const queries = calls.filter(call => call.sql)
  assert.match(queries[0].sql, /^SELECT `files` FROM `control` WHERE `id` = \? FOR UPDATE$/)
  assert.equal(queries[0].source, 'connection')
  assert.deepEqual(queries[0].params, ['1'])
  assert.match(queries[1].sql, /^UPDATE `control` SET `files` = \? WHERE `id` = \?$/)
  assert.deepEqual(queries[1].params, [JSON.stringify([FILE_A, FILE_B]), '1'])
  assert.equal(queries[1].source, 'connection')
})

test('attachment input validates IDs, filenames, types and bounded sizes before acquiring a transaction', async () => {
  const { repo, calls } = await repository()
  for (const files of [[], null, [{ ...FILE_A, id: '../secret' }], [{ ...FILE_A, name: '../secret' }],
    [{ ...FILE_A, name: 'C:\\secret' }], [{ ...FILE_A, name: 'x\u0000.pdf' }], [{ ...FILE_A, name: 'x\u0085.pdf' }], [{ ...FILE_A, name: 'x'.repeat(256) }],
    [{ ...FILE_A, size: '26214401' }], [{ ...FILE_A, size: 1 }], [{ ...FILE_A, size: '-1' }],
    [{ ...FILE_A, mime_type: 'text/plain\r\nx: injected' }], [{ ...FILE_A, path: '/private' }], [FILE_A, FILE_A]]) {
    await assert.rejects(repo.addFiles('1', files), { code: 3 })
  }
  await assert.rejects(repo.getFile('1', '../secret'), { code: 3 })
  await assert.rejects(repo.removeFile('1', 'bad-id'), { code: 3 })
  assert.equal(calls.length, 0)
})

test('duplicate stored UUID, missing row, and metadata write failure roll back and release', async () => {
  const { repo, calls } = await repository([[{ files: [FILE_A] }], [], [{ files: [] }], new Error('secret write failure')])
  await assert.rejects(repo.addFiles('1', [FILE_A]), { code: 6 })
  await assert.rejects(repo.addFiles('2', [FILE_B]), { code: 5 })
  await assert.rejects(repo.addFiles('3', [FILE_B]), error => error.code === 14 && !error.message.includes('secret'))
  assert.equal(calls.filter(call => call.action === 'rollback').length, 3)
  assert.equal(calls.filter(call => call.action === 'release').length, 3)
  assert.equal(calls.filter(call => call.action === 'commit').length, 0)
})

test('the per-row metadata limit refuses append without replacing existing attachments', async () => {
  const files = Array.from({ length: 1000 }, (_, index) => ({ ...FILE_A, id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}` }))
  const { repo, calls } = await repository([[{ files }]])
  await assert.rejects(repo.addFiles('1', [FILE_B]), error => error.code === 8 && error.metadataRolledBack === true)
  assert.equal(calls.filter(call => call.sql?.startsWith('UPDATE')).length, 0)
  assert.ok(calls.some(call => call.action === 'rollback'))
})

test('failed metadata UPDATE permits staged-content cleanup only after confirmed rollback', async () => {
  const { repo, calls } = await repository([[{ files: [] }], new Error('secret failed UPDATE')])
  await assert.rejects(repo.addFiles('1', [FILE_B]), error => error.code === 14
    && error.metadataRolledBack === true && !error.message.includes('secret'))
  assert.deepEqual(calls.filter(call => call.action).map(call => call.action), ['acquire', 'begin', 'rollback', 'release'])
})

test('lost COMMIT response remains uncertain even when a subsequent rollback succeeds', async () => {
  const { repo, calls } = await repository([[{ files: [] }], { affectedRows: 1 }], { commit: new Error('secret lost COMMIT response') })
  await assert.rejects(repo.addFiles('1', [FILE_B]), error => error.code === 14
    && !Object.hasOwn(error, 'metadataRolledBack') && !error.message.includes('secret'))
  assert.deepEqual(calls.filter(call => call.action).map(call => call.action), ['acquire', 'begin', 'commit', 'rollback', 'release'])
})

test('failed rollback never certifies metadata cleanup and destroys the dirty connection', async () => {
  const { repo, calls } = await repository([[{ files: [] }], new Error('secret failed UPDATE')], { rollback: new Error('secret failed rollback') })
  await assert.rejects(repo.addFiles('1', [FILE_B]), error => error.code === 14
    && !Object.hasOwn(error, 'metadataRolledBack') && !error.message.includes('secret'))
  assert.deepEqual(calls.filter(call => call.action).map(call => call.action), ['acquire', 'begin', 'rollback', 'destroy'])
})

test('dependency failures before metadata operations certify that no metadata could have been published', async () => {
  for (const phase of ['acquire', 'begin']) {
    const { repo, calls } = await repository([], { [phase]: new Error(`secret ${phase} failure`) })
    await assert.rejects(repo.addFiles('1', [FILE_B]), error => error.code === 14
      && error.metadataRolledBack === true && !error.message.includes('secret'))
    assert.ok(!calls.some(call => call.sql))
    assert.ok(!calls.some(call => call.action === 'commit'))
  }
})

test('file lookups require ownership by the requested row and validate stored metadata', async () => {
  const { repo, calls } = await repository([[{ files: JSON.stringify([FILE_A]) }], [{ files: [] }], [],
    [{ files: JSON.stringify([{ ...FILE_A, name: '../private' }]) }], [{ files: 'not-json' }]])
  assert.deepEqual(await repo.getFile('1', FILE_A.id), FILE_A)
  assert.deepEqual(calls[0].params, ['1'])
  await assert.rejects(repo.getFile('2', FILE_A.id), { code: 5 })
  await assert.rejects(repo.getFile('3', FILE_A.id), { code: 5 })
  await assert.rejects(repo.getFile('4', FILE_A.id), { code: 13 })
  await assert.rejects(repo.getFile('5', FILE_A.id), { code: 13 })
})

test('removal locks current metadata and returns the removed file after commit', async () => {
  const { repo, calls } = await repository([[{ files: [FILE_A, FILE_B] }], { affectedRows: 1 }, [{ files: [FILE_B] }]])
  assert.deepEqual(await repo.removeFile('1', FILE_A.id), FILE_A)
  const update = calls.find(call => call.sql?.startsWith('UPDATE'))
  assert.deepEqual(update.params, [JSON.stringify([FILE_B]), '1'])
  assert.ok(calls.some(call => call.sql?.endsWith('FOR UPDATE')))
  assert.ok(calls.some(call => call.action === 'commit'))
  await assert.rejects(repo.removeFile('1', FILE_A.id), { code: 5 })
  assert.equal(calls.filter(call => call.action === 'release').length, 2)
})

test('deleting a row locks attachments and refuses attached rows without issuing DELETE', async () => {
  const { repo, calls } = await repository([[{ files: [FILE_A] }], [{ files: [] }], { affectedRows: 1 }, []])
  await assert.rejects(repo.delete('1'), { code: 9 })
  assert.equal(calls.filter(call => call.sql?.startsWith('DELETE')).length, 0)
  assert.deepEqual(await repo.delete('2'), { deleted: true })
  await assert.rejects(repo.delete('3'), { code: 5 })
  assert.ok(calls.filter(call => call.sql?.startsWith('SELECT')).every(call => call.sql.endsWith('FOR UPDATE')))
  assert.equal(calls.filter(call => call.action === 'rollback').length, 2)
  assert.equal(calls.filter(call => call.action === 'commit').length, 1)
  assert.equal(calls.filter(call => call.action === 'release').length, 3)
})
