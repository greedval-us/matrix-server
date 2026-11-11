import { readFileSync } from 'node:fs'
import { hashPassword } from '../node/web-admin/auth.mjs'

try {
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '')
  console.log(await hashPassword(password))
} catch {
  console.error('Could not hash the web admin password from standard input')
  process.exitCode = 1
}
