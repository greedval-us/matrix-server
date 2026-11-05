CREATE TABLE IF NOT EXISTS `control` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `date` DATE NULL DEFAULT (CURRENT_DATE),
  `number` VARCHAR(64) NULL,
  `fio` VARCHAR(255) NULL,
  `date_of_birth` DATE NULL,
  `executor` VARCHAR(255) NULL,
  `note` TEXT NULL,
  `realization` TEXT NULL,
  `intersections` TEXT NULL,
  `files` JSON NOT NULL DEFAULT (JSON_ARRAY()),
  PRIMARY KEY (`id`),
  KEY `control_date_id` (`date`, `id`),
  CONSTRAINT `control_files_array` CHECK (JSON_TYPE(`files`) = 'ARRAY')
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
