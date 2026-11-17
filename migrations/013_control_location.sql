SET @matrix_control_location_ddl = IF(
  EXISTS (
    SELECT 1 FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE() AND `table_name` = 'control' AND `column_name` = 'location'
  ),
  'SELECT 1',
  'ALTER TABLE `control`
    ADD COLUMN `location` VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL DEFAULT ''Неизвестно'' AFTER `executor`,
    ADD CONSTRAINT `control_location_allowed` CHECK (`location` IN (''В РФ'', ''Выехал из РФ'', ''Неизвестно''))'
);
PREPARE matrix_control_location FROM @matrix_control_location_ddl;
EXECUTE matrix_control_location;
DEALLOCATE PREPARE matrix_control_location;
