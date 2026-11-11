CREATE TABLE IF NOT EXISTS `access_keys` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `label` VARCHAR(255) NOT NULL,
  `key_digest` BINARY(32) NOT NULL,
  `device_key` BINARY(44) NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `activated_at` TIMESTAMP(3) NULL DEFAULT NULL,
  `revoked_at` TIMESTAMP(3) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `access_keys_key_digest` (`key_digest`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `access_key_nonces` (
  `access_key_id` BIGINT UNSIGNED NOT NULL,
  `nonce` BINARY(16) NOT NULL,
  `expires_at` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`access_key_id`, `nonce`),
  KEY `access_key_nonces_key_expiry` (`access_key_id`, `expires_at`),
  CONSTRAINT `access_key_nonces_key_fk` FOREIGN KEY (`access_key_id`) REFERENCES `access_keys` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `access_key_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `access_key_id` BIGINT UNSIGNED NOT NULL,
  `module` VARCHAR(128) CHARACTER SET ascii NOT NULL,
  `method` VARCHAR(128) CHARACTER SET ascii NOT NULL,
  `status_code` TINYINT UNSIGNED NOT NULL,
  `duration_ms` INT UNSIGNED NOT NULL,
  `created_at` TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `access_key_logs_key_id` (`access_key_id`, `id`),
  CONSTRAINT `access_key_logs_key_fk` FOREIGN KEY (`access_key_id`) REFERENCES `access_keys` (`id`)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
