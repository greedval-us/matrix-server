export const CATALOG_FIELDS = Object.freeze([
  'id', 'name_table', 'name', 'info', 'relevance_date', 'country',
  'access_level', 'type', 'trust', 'count', 'search_mail', 'search_fio',
  'search_number', 'search_telegram', 'search_passport', 'search_snils',
  'search_inn', 'search_imei', 'search_imsi', 'search_facebook', 'search_vk',
  'search_grz', 'search_vin', 'updated_at', 'created_at',
])

const resource = (fields, writable, required = []) => Object.freeze({
  fields: Object.freeze(fields), writable: Object.freeze(writable), required: Object.freeze(required),
})

export const RESOURCES = Object.freeze({
  data_base: resource(CATALOG_FIELDS, CATALOG_FIELDS, ['name_table']),
  work_items: resource(
    ['id', 'namespace', 'name', 'payload', 'created_at', 'updated_at'],
    ['namespace', 'name', 'payload'], ['namespace', 'name'],
  ),
  service_logs: resource(
    ['id', 'module', 'method', 'status_code', 'duration_ms', 'created_at'], [],
  ),
})
