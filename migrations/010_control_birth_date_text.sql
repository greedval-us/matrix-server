SET @matrix_control_has_legacy_birth_date = EXISTS (
  SELECT 1 FROM `information_schema`.`columns`
  WHERE `table_schema` = DATABASE() AND `table_name` = 'control' AND `column_name` = 'birth_date_text'
);

SET @matrix_control_birth_date_sql = IF(
  @matrix_control_has_legacy_birth_date AND NOT EXISTS (
    SELECT 1 FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE() AND `table_name` = 'control' AND `column_name` = 'date_of_birth_merged'
  ),
  'ALTER TABLE `control` ADD COLUMN `date_of_birth_merged` TEXT NULL AFTER `date_of_birth`',
  'SELECT 1'
);
PREPARE matrix_control_birth_date FROM @matrix_control_birth_date_sql;
EXECUTE matrix_control_birth_date;
DEALLOCATE PREPARE matrix_control_birth_date;

SET @matrix_control_birth_date_sql = IF(
  @matrix_control_has_legacy_birth_date,
  'UPDATE `control` SET `date_of_birth_merged` = CASE
    WHEN `birth_date_text` IS NULL OR TRIM(`birth_date_text`) = '''' THEN CAST(`date_of_birth` AS CHAR)
    WHEN `date_of_birth` IS NULL OR CAST(TRIM(`birth_date_text`) AS BINARY) IN (
      CAST(CAST(`date_of_birth` AS CHAR) AS BINARY),
      CAST(DATE_FORMAT(`date_of_birth`, ''%d.%m.%Y'') AS BINARY),
      CAST(DATE_FORMAT(`date_of_birth`, ''%d.%c.%Y'') AS BINARY),
      CAST(DATE_FORMAT(`date_of_birth`, ''%e.%m.%Y'') AS BINARY),
      CAST(DATE_FORMAT(`date_of_birth`, ''%e.%c.%Y'') AS BINARY)
    ) THEN `birth_date_text`
    ELSE CONCAT(`birth_date_text`, '' / '', CAST(`date_of_birth` AS CHAR))
  END',
  'SELECT 1'
);
PREPARE matrix_control_birth_date FROM @matrix_control_birth_date_sql;
EXECUTE matrix_control_birth_date;
DEALLOCATE PREPARE matrix_control_birth_date;

SET @matrix_control_birth_date_sql = IF(
  @matrix_control_has_legacy_birth_date,
  'ALTER TABLE `control` DROP COLUMN `date_of_birth`, DROP COLUMN `birth_date_text`,
    CHANGE COLUMN `date_of_birth_merged` `date_of_birth` TEXT NULL',
  'SELECT 1'
);
PREPARE matrix_control_birth_date FROM @matrix_control_birth_date_sql;
EXECUTE matrix_control_birth_date;
DEALLOCATE PREPARE matrix_control_birth_date;
