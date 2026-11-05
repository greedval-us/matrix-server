CREATE TABLE IF NOT EXISTS `data_base` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name_table` VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `name` VARCHAR(255) NULL,
  `info` TEXT NULL,
  `relevance_date` VARCHAR(255) NULL,
  `country` VARCHAR(255) NULL,
  `access_level` VARCHAR(255) NULL,
  `type` VARCHAR(255) NULL,
  `trust` VARCHAR(255) NULL,
  `count` BIGINT UNSIGNED NULL,
  `search_mail` TINYINT UNSIGNED NULL,
  `search_fio` TINYINT UNSIGNED NULL,
  `search_number` TINYINT UNSIGNED NULL,
  `search_telegram` TINYINT UNSIGNED NULL,
  `search_passport` TINYINT UNSIGNED NULL,
  `search_snils` TINYINT UNSIGNED NULL,
  `search_inn` TINYINT UNSIGNED NULL,
  `search_imei` TINYINT UNSIGNED NULL,
  `search_imsi` TINYINT UNSIGNED NULL,
  `search_facebook` TINYINT UNSIGNED NULL,
  `search_vk` TINYINT UNSIGNED NULL,
  `search_grz` TINYINT UNSIGNED NULL,
  `search_vin` TINYINT UNSIGNED NULL,
  `updated_at` VARCHAR(255) NULL,
  `created_at` VARCHAR(255) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `data_base_name_table` (`name_table`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `work_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `namespace` VARCHAR(128) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `payload` JSON NOT NULL DEFAULT (JSON_OBJECT()),
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `work_items_namespace_name` (`namespace`, `name`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_cs;

CREATE TABLE IF NOT EXISTS `service_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `module` VARCHAR(128) CHARACTER SET ascii NOT NULL,
  `method` VARCHAR(128) CHARACTER SET ascii NOT NULL,
  `status_code` TINYINT UNSIGNED NOT NULL,
  `duration_ms` INT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `service_logs_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
