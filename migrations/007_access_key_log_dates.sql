SET @matrix_access_key_log_date_ddl = IF(
  EXISTS (
    SELECT 1 FROM `information_schema`.`statistics`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'access_key_logs'
      AND `index_name` = 'access_key_logs_created_at'
  ),
  'SELECT 1',
  'CREATE INDEX `access_key_logs_created_at` ON `access_key_logs` (`created_at`) ALGORITHM=INPLACE LOCK=NONE'
);
PREPARE matrix_access_key_log_date_index FROM @matrix_access_key_log_date_ddl;
EXECUTE matrix_access_key_log_date_index;
DEALLOCATE PREPARE matrix_access_key_log_date_index;
