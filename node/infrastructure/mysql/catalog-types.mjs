export function normalizeCatalogTypeName(value) {
  if (typeof value !== 'string' || !value.isWellFormed()) return null
  const name = value.normalize().replace(/\p{White_Space}+/gu, ' ').trim()
  if (!name || [...name].length > 255 || /\p{Cc}/u.test(name)) return null
  return name
}
