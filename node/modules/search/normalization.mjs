export const SEARCH_FIELDS = Object.freeze([
  'number',
  'mail',
  'snils',
  'inn',
  'passport',
  'fio',
  'date_of_birth',
  'telegram',
  'vk',
  'facebook',
  'imsi',
  'imei',
  'grz',
  'vin',
])

const SEARCH_FIELD_SET = new Set(SEARCH_FIELDS)
const MIN_WILDCARD_LITERAL = Object.freeze({
  number: 6,
  passport: 4,
  inn: 4,
  snils: 4,
  telegram: 4,
  vk: 4,
  facebook: 4,
  imsi: 6,
  imei: 6,
  mail: 4,
  fio: 3,
  date_of_birth: 4,
  grz: 3,
  vin: 4,
})

export class InvalidSearchQuery extends Error {}

function escapeManticorePhrase(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '*')
}

export function normalizeQuery(field, value) {
  if (!SEARCH_FIELD_SET.has(field)) {
    throw new InvalidSearchQuery(`Unsupported search field: ${field}`)
  }
  const original = String(value ?? '').trim()
  if (!original) {
    throw new InvalidSearchQuery(`Empty search value for ${field}`)
  }

  if ([...original].length > 512 || /[\u0000-\u001f\u007f]/u.test(original)) {
    throw new InvalidSearchQuery(`Invalid search value for ${field}`)
  }
  const wildcard = original.includes('%') || original.includes('?')
  const pattern = original

  if (!/[\p{L}\p{N}]/u.test(pattern)) {
    throw new InvalidSearchQuery(`Search value for ${field} has no searchable characters`)
  }
  if (wildcard) {
    const literalRuns = pattern.match(/[\p{L}\p{N}]+/gu) ?? []
    const longestLiteral = literalRuns.reduce(
      (maximum, part) => Math.max(maximum, [...part].length),
      0,
    )
    const required = MIN_WILDCARD_LITERAL[field]
    if (longestLiteral < required) {
      throw new InvalidSearchQuery(
        `Wildcard search for ${field} requires at least ${required} consecutive characters`,
      )
    }
  }

  return Object.freeze({
    field,
    original,
    pattern,
    manticorePattern: `"${escapeManticorePhrase(pattern)}"`,
    wildcard,
  })
}

export function buildManticoreQuery(values) {
  const normalized = SEARCH_FIELDS
    .filter((field) => values[field])
    .map((field) => normalizeQuery(field, values[field]))
  if (normalized.length === 0) {
    throw new InvalidSearchQuery('At least one search field is required')
  }
  const expression = normalized
    .map((query) => `(@${query.field} ${query.manticorePattern})`)
    .join(' ')
  return { expression, normalized }
}

