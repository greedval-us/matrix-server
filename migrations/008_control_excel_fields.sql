SET @matrix_control_excel_columns = CONCAT_WS(', ',
  IF(EXISTS (
    SELECT 1 FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE() AND `table_name` = 'control' AND `column_name` = 'source_id'
  ), NULL, 'ADD COLUMN `source_id` VARCHAR(255) NULL AFTER `id`'),
  IF(EXISTS (
    SELECT 1 FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE() AND `table_name` = 'control' AND `column_name` = 'birth_date_text'
  ), NULL, 'ADD COLUMN `birth_date_text` VARCHAR(255) NULL AFTER `date_of_birth`'),
  IF(EXISTS (
    SELECT 1 FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE() AND `table_name` = 'control' AND `column_name` = 'group_chat_locality'
  ), NULL, 'ADD COLUMN `group_chat_locality` VARCHAR(255) NULL AFTER `birth_date_text`')
);
SET @matrix_control_excel_ddl = IF(
  @matrix_control_excel_columns = '',
  'SELECT 1',
  CONCAT('ALTER TABLE `control` ', @matrix_control_excel_columns)
);
PREPARE matrix_control_excel_fields FROM @matrix_control_excel_ddl;
EXECUTE matrix_control_excel_fields;
DEALLOCATE PREPARE matrix_control_excel_fields;
