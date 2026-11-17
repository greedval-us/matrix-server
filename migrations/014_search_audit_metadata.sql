SET @matrix_search_audit_fields_ddl = IF(
  EXISTS (
    SELECT 1 FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE() AND `table_name` = 'access_key_logs' AND `column_name` = 'search_fields'
  ),
  NULL,
  'ADD COLUMN `search_fields` JSON NULL'
);
SET @matrix_search_audit_matches_ddl = IF(
  EXISTS (
    SELECT 1 FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE() AND `table_name` = 'access_key_logs' AND `column_name` = 'search_had_matches'
  ),
  NULL,
  'ADD COLUMN `search_had_matches` TINYINT UNSIGNED NULL'
);
SET @matrix_search_audit_ddl = IF(
  @matrix_search_audit_fields_ddl IS NULL AND @matrix_search_audit_matches_ddl IS NULL,
  'SELECT 1',
  CONCAT('ALTER TABLE `access_key_logs` ', CONCAT_WS(', ', @matrix_search_audit_fields_ddl, @matrix_search_audit_matches_ddl), ', ALGORITHM=INSTANT')
);
PREPARE matrix_search_audit_metadata FROM @matrix_search_audit_ddl;
EXECUTE matrix_search_audit_metadata;
DEALLOCATE PREPARE matrix_search_audit_metadata;
