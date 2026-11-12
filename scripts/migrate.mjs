import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createMysqlPool } from '../node/infrastructure/mysql/pool.mjs'
import { readMysqlSettings } from '../node/infrastructure/mysql/settings.mjs'

export async function runMigrations(pool, { directory = fileURLToPath(new URL('../migrations/', import.meta.url)) } = {}) {
  const connection = await pool.getConnection()
  let locked = false
  try {
    const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', ['matrix:migrations'])
    if (Number(lock.acquired) !== 1) throw new Error('Cannot acquire migration lock')
    locked = true
    await connection.query('CREATE TABLE IF NOT EXISTS `schema_migrations` (`version` VARCHAR(255) NOT NULL PRIMARY KEY, `checksum` CHAR(64) NOT NULL, `applied_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB')
    const [existing] = await connection.execute('SELECT `version`, `checksum` FROM `schema_migrations` ORDER BY `version`')
    const applied = new Map(existing.map(row => [row.version, row.checksum]))
    const files = (await readdir(directory)).filter(name => /^[0-9]+_[A-Za-z0-9_-]+\.sql$/.test(name)).sort()
    const completed = []
    for (const version of files) {
      const source = await readFile(path.join(directory, version), 'utf8')
      const checksum = createHash('sha256').update(source).digest('hex')
      if (applied.has(version)) {
        if (applied.get(version) !== checksum) throw new Error(`Migration checksum mismatch: ${version}`)
        continue
      }
      // MySQL DDL commits implicitly. Schema statements and seed inserts must
      // be safe to rerun if a migration is interrupted.
      for (const statement of source.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement)
      await connection.execute('INSERT INTO `schema_migrations` (`version`, `checksum`) VALUES (?, ?)', [version, checksum])
      completed.push(version)
    }
    return completed
  } finally {
    try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', ['matrix:migrations']) }
    finally { connection.release() }
  }
}

async function main() {
  const pool = createMysqlPool(readMysqlSettings())
  try {
    const completed = await runMigrations(pool)
    console.log(`Applied ${completed.length} migration(s)`)
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Migration failed; check database configuration and migration state'); process.exitCode = 1 })
}
