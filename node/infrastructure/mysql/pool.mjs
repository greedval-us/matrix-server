import mysql from 'mysql2/promise'

export function createMysqlPool(settings, driver = mysql) {
  return driver.createPool({
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    connectionLimit: settings.connectionLimit ?? 10,
    waitForConnections: true,
    queueLimit: 100,
    connectTimeout: 10_000,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    jsonStrings: true,
    multipleStatements: false,
  })
}
