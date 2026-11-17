import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../core/errors.mjs'

const pageSize = 50
const invalid = () => new ApplicationError(grpc.status.INVALID_ARGUMENT, 'Invalid search field label request')
const metadata = ({ field_key, label }) => ({ field_key, label })

function validText(value, maximum) {
  return typeof value === 'string' && value.isWellFormed() && [...value].length <= maximum
    && !/\p{Cc}/u.test(value)
}

export function createFieldLabelEditor(repository) {
  return {
    async list({ query = '', page = 1 } = {}) {
      if (!Number.isSafeInteger(page) || page < 1 || !validText(query, 255)) throw invalid()
      const offset = (page - 1) * pageSize
      if (!Number.isSafeInteger(offset)) throw invalid()
      const text = query.trim()
      const filter = text
        ? ' WHERE (LOCATE(?, `field_key` COLLATE utf8mb4_0900_as_ci) > 0 OR LOCATE(?, `label` COLLATE utf8mb4_0900_as_ci) > 0)'
        : ''
      const parameters = text ? [text, text] : []
      const rows = await repository.execute(
        'SELECT `field_key`, `label` FROM `search_field_labels`' + filter + ' ORDER BY `field_key` LIMIT ? OFFSET ?',
        [...parameters, pageSize, offset],
      )
      const [count] = await repository.execute('SELECT COUNT(`field_key`) AS total FROM `search_field_labels`' + filter, parameters)
      return { rows: rows.map(metadata), total: Number(count.total), page, pageSize }
    },
    async update(key, value) {
      if (!validText(key, 64) || !key.length || !validText(value, 255)) throw invalid()
      const label = value.trim()
      if (!label) throw invalid()
      await repository.execute('UPDATE `search_field_labels` SET `label` = ? WHERE `field_key` = ?', [label, key])
      const [row] = await repository.execute('SELECT `field_key`, `label` FROM `search_field_labels` WHERE `field_key` = ?', [key])
      if (!row) throw new ApplicationError(grpc.status.NOT_FOUND, 'Search field label was not found')
      return metadata(row)
    },
  }
}
