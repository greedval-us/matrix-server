UPDATE `data_base` AS `catalog`
JOIN (
  SELECT 'Госструктуры' AS `old_type`, 'Госструктуры и реестры' AS `new_type`
  UNION ALL SELECT 'Государственные системы и реестры', 'Госструктуры и реестры'
  UNION ALL SELECT 'Госструктуры и реестры', 'Госструктуры и реестры'
  UNION ALL SELECT 'Магазины', 'Магазины и ритейл'
  UNION ALL SELECT 'Интернет-магазины и ритейл', 'Магазины и ритейл'
  UNION ALL SELECT 'Магазины и ритейл', 'Магазины и ритейл'
  UNION ALL SELECT 'Медицина', 'Медицина'
  UNION ALL SELECT 'Медицинские данные', 'Медицина'
  UNION ALL SELECT 'Связь', 'Связь и операторы'
  UNION ALL SELECT 'Связь и операторы', 'Связь и операторы'
  UNION ALL SELECT 'Социальные платформы', 'Социальные сети и мессенджеры'
  UNION ALL SELECT 'Социальные сети (мессенджеры)', 'Социальные сети и мессенджеры'
  UNION ALL SELECT 'Социальные сети и мессенджеры', 'Социальные сети и мессенджеры'
  UNION ALL SELECT 'Услуги', 'Услуги, туризм и обучение'
  UNION ALL SELECT 'Услуги, туризм и обучение', 'Услуги, туризм и обучение'
  UNION ALL SELECT 'Финансы', 'Финансы и банки'
  UNION ALL SELECT 'Банковские данные', 'Финансы и банки'
  UNION ALL SELECT 'Финансы и банки', 'Финансы и банки'
  UNION ALL SELECT 'Сайты', 'IT, сайты и почтовые сервисы'
  UNION ALL SELECT 'Электронная почта', 'IT, сайты и почтовые сервисы'
  UNION ALL SELECT 'IT, сайты и почтовые сервисы', 'IT, сайты и почтовые сервисы'
) AS `aliases`
  ON TRIM(REGEXP_REPLACE(`catalog`.`type`, '[[:space:]]+', ' ')) COLLATE utf8mb4_0900_as_ci = `aliases`.`old_type`
SET `catalog`.`type` = `aliases`.`new_type`
WHERE CAST(`catalog`.`type` AS BINARY) <> CAST(`aliases`.`new_type` AS BINARY);
