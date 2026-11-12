CREATE TABLE IF NOT EXISTS `catalog_types` (
  `name` VARCHAR(255) NOT NULL PRIMARY KEY,
  `alias_for` VARCHAR(255) NULL,
  CONSTRAINT `catalog_types_alias_fk` FOREIGN KEY (`alias_for`) REFERENCES `catalog_types` (`name`),
  CONSTRAINT `catalog_types_name_nonempty` CHECK (CHAR_LENGTH(TRIM(`name`)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_as_ci;

INSERT INTO `catalog_types` (`name`) VALUES
  ('Госструктуры и реестры'),
  ('Магазины и ритейл'),
  ('Медицина'),
  ('Связь и операторы'),
  ('Социальные сети и мессенджеры'),
  ('Услуги, туризм и обучение'),
  ('Финансы и банки'),
  ('IT, сайты и почтовые сервисы')
ON DUPLICATE KEY UPDATE `name` = `catalog_types`.`name`;

INSERT INTO `catalog_types` (`name`, `alias_for`) VALUES
  ('Госструктуры', 'Госструктуры и реестры'),
  ('Государственные системы и реестры', 'Госструктуры и реестры'),
  ('Магазины', 'Магазины и ритейл'),
  ('Интернет-магазины и ритейл', 'Магазины и ритейл'),
  ('Медицинские данные', 'Медицина'),
  ('Связь', 'Связь и операторы'),
  ('Социальные платформы', 'Социальные сети и мессенджеры'),
  ('Социальные сети (мессенджеры)', 'Социальные сети и мессенджеры'),
  ('Услуги', 'Услуги, туризм и обучение'),
  ('Финансы', 'Финансы и банки'),
  ('Банковские данные', 'Финансы и банки'),
  ('Сайты', 'IT, сайты и почтовые сервисы'),
  ('Электронная почта', 'IT, сайты и почтовые сервисы')
ON DUPLICATE KEY UPDATE `name` = `catalog_types`.`name`;

INSERT INTO `catalog_types` (`name`)
SELECT MIN(`cleaned`.`name` COLLATE utf8mb4_0900_bin)
FROM (
  SELECT TRIM(REGEXP_REPLACE(`type`, '[[:space:]]+', ' ')) AS `name` FROM `data_base`
) AS `cleaned`
WHERE CHAR_LENGTH(`cleaned`.`name`) > 0
GROUP BY `cleaned`.`name` COLLATE utf8mb4_0900_as_ci
ON DUPLICATE KEY UPDATE `name` = `catalog_types`.`name`;
