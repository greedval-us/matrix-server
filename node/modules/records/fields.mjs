import { ApplicationError } from '../../core/errors.mjs'

export const CONTROL_COLUMNS = Object.freeze([
  { key: 'date', label: 'Дата', type: 'date', sortable: true },
  { key: 'id', label: 'ID', type: 'text', sortable: true },
  { key: 'number', label: 'Номер', type: 'text', sortable: true },
  { key: 'fio', label: 'ФИО', type: 'text', sortable: true },
  { key: 'date_of_birth', label: 'Дата рождения', type: 'date', sortable: true },
  { key: 'initiator', label: 'Инициатор', type: 'text', sortable: true },
  { key: 'executor', label: 'Исполнитель', type: 'text', sortable: true },
  { key: 'note', label: 'Примечание', type: 'text', sortable: true },
  { key: 'realization', label: 'Реализация', type: 'text', sortable: true },
  { key: 'intersections', label: 'Пересечения', type: 'text', sortable: true },
].map(Object.freeze))

export const CONTROL_FIELDS = Object.freeze(CONTROL_COLUMNS.map(column => column.key))
export const MAX_ROW_FILES = 1000
const UINT64_MAX = 18446744073709551615n
const writable = new Set(CONTROL_FIELDS.filter(key => key !== 'id'))
const dates = new Set(['date', 'date_of_birth'])
const text = new Set(['note', 'realization', 'intersections'])
export const invalid = () => new ApplicationError(3, 'Invalid control record request')

export function validateId(id) {
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > UINT64_MAX) throw invalid()
  return id
}

function calendarDate(value) {
  if (!/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) throw invalid()
  const [year, month, day] = value.split('-').map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw invalid()
  return value
}

export function validateValues(values, { create = false } = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(values))) throw invalid()
  const entries = Object.entries(values)
  if (!create && entries.length === 0) throw invalid()
  return entries.map(([key, value]) => {
    if (!writable.has(key) || typeof value !== 'string') throw invalid()
    if (dates.has(key)) return [key, value === '' ? null : calendarDate(value)]
    if (text.has(key) ? Buffer.byteLength(value, 'utf8') > 65_535 : [...value].length > (key === 'number' ? 64 : 255)) throw invalid()
    return [key, value]
  })
}

export function validateFileId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw invalid()
  return id
}

export function validateFiles(files, { empty = false } = {}) {
  if (!Array.isArray(files) || (!empty && files.length === 0) || files.length > MAX_ROW_FILES) throw invalid()
  const ids = new Set()
  return files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || Object.keys(file).some(key => !['id', 'name', 'size', 'mime_type'].includes(key))) throw invalid()
    const id = validateFileId(file.id)
    const { name, size, mime_type } = file
    if (ids.has(id) || typeof name !== 'string' || !name.trim() || name === '.' || name === '..'
      || [...name].length > 255 || /[\\/:\p{Cc}]/u.test(name)
      || typeof size !== 'string' || !/^(0|[1-9][0-9]{0,7})$/.test(size) || BigInt(size) > 26_214_400n
      || typeof mime_type !== 'string' || mime_type.length > 255
      || (mime_type !== '' && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mime_type))) throw invalid()
    ids.add(id)
    return { id, name, size, mime_type }
  })
}

export function readFiles(value) {
  try { return validateFiles(typeof value === 'string' ? JSON.parse(value) : value, { empty: true }) }
  catch { throw new ApplicationError(13, 'Invalid stored control file metadata') }
}

export function listOptions(request = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw invalid()
  const { query = '', sort_key = '', sort_direction = '', page = 0, page_size = 0 } = request
  if (typeof query !== 'string' || [...query].length > 4096
    || (sort_key !== '' && !CONTROL_FIELDS.includes(sort_key))
    || !['', 'asc', 'desc'].includes(sort_direction)
    || !Number.isSafeInteger(page) || page < 0 || page > 4_294_967_295
    || !Number.isSafeInteger(page_size) || page_size < 0 || page_size > 1000) throw invalid()
  const limit = page_size || 100
  return { query, key: sort_key || 'date', direction: (sort_direction || 'desc').toUpperCase(), limit, offset: ((page || 1) - 1) * limit }
}
