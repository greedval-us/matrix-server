const DOCUMENT_ID_DIVISOR = 1n << 32n

export function decodeDocumentId(value) {
  let id
  try {
    id = BigInt(value)
  } catch {
    throw new Error(`Manticore returned an invalid document id: ${value}`)
  }
  const databaseId = Number(id / DOCUMENT_ID_DIVISOR)
  const rowId = id % DOCUMENT_ID_DIVISOR
  if (!Number.isSafeInteger(databaseId) || databaseId <= 0 || rowId <= 0n) {
    throw new Error(`Manticore returned an invalid document id: ${value}`)
  }
  return { databaseId, rowId: rowId.toString() }
}

export function parseStoredFields(value) {
  let source
  try {
    source = typeof value === 'string' ? JSON.parse(value) : value
  } catch (error) {
    throw new Error(`Manticore returned invalid row JSON: ${error.message}`)
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Manticore returned an invalid stored row')
  }
  return Object.fromEntries(Object.entries(source).map(([key, fieldValue]) => {
    if (fieldValue == null) return [key, '']
    if (typeof fieldValue === 'object') return [key, JSON.stringify(fieldValue)]
    return [key, String(fieldValue)]
  }))
}
