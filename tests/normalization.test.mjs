import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InvalidSearchQuery,
  buildManticoreQuery,
  normalizeQuery,
} from '../node/normalization.mjs'

test('Matrix percent wildcard becomes a Manticore star', () => {
  assert.equal(normalizeQuery('number', '799912%1234').manticorePattern, '"799912*1234"')
})

test('question mark remains a one-character wildcard', () => {
  assert.equal(normalizeQuery('passport', '4501?234').manticorePattern, '"4501?234"')
})

test('FIO is preserved and searched as an exact phrase', () => {
  assert.equal(normalizeQuery('fio', 'Иванов Иван').manticorePattern, '"Иванов Иван"')
})

test('mail punctuation is preserved', () => {
  assert.equal(normalizeQuery('mail', '0fier0@mail.ru').manticorePattern, '"0fier0@mail.ru"')
})

test('short wildcard queries are rejected', () => {
  assert.throws(() => normalizeQuery('number', '12%'), InvalidSearchQuery)
})

test('multiple fields are combined with implicit AND', () => {
  assert.equal(
    buildManticoreQuery({ number: '79991234567', inn: '1234567890' }).expression,
    '(@number "79991234567") (@inn "1234567890")',
  )
})

