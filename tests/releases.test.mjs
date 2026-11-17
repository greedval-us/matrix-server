import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import grpc from '@grpc/grpc-js'
import { ReleaseStore } from '../node/modules/releases/store.mjs'
import { publishRelease } from '../node/modules/releases/publish.mjs'

const target = { platform: 'win32', arch: 'x64', kind: 'portable' }
const collect = async source => { const result = []; for await (const item of source) result.push(item); return result }

async function fixture(t, content = Buffer.from('application bytes')) {
  const root = await mkdtemp(path.join(tmpdir(), 'matrix-releases-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'client.exe')
  const directory = path.join(root, 'published')
  await writeFile(file, content)
  return { root, file, directory, content, store: new ReleaseStore(directory), publish: options => publishRelease({ directory, file, version: '1.2.3', ...target, ...options }) }
}

test('publisher computes metadata and streams a stable release in bounded chunks', async t => {
  const f = await fixture(t, Buffer.alloc(600_123, 37))
  const release = await f.publish({ notes: 'Исправлен поиск' })
  assert.deepEqual(release, {
    version: '1.2.3', ...target, name: 'Matrix-1.2.3-win32-x64-portable.exe',
    size: '600123', sha256: createHash('sha256').update(f.content).digest('hex'),
    published_at: release.published_at, notes: 'Исправлен поиск',
  })
  assert.ok(Number.isFinite(Date.parse(release.published_at)))
  assert.deepEqual(await f.store.latest(target), release)
  const frames = await collect(f.store.download({ ...target, version: release.version, sha256: release.sha256 }))
  assert.deepEqual(frames[0], { release })
  assert.deepEqual(frames.slice(1).map(frame => frame.data.length), [262144, 262144, 75835])
  assert.deepEqual(Buffer.concat(frames.slice(1).map(frame => frame.data)), f.content)
  assert.ok((await readdir(f.directory)).every(name => !name.endsWith('.tmp') && name !== '.publish.lock'))
})

test('targets are isolated and publishing never replaces a version with different bytes or downgrades latest', async t => {
  const f = await fixture(t)
  const first = await f.publish()
  await assert.rejects(f.store.latest({ ...target, arch: 'arm64' }), { code: grpc.status.NOT_FOUND })
  await f.publish({ platform: 'linux', arch: 'arm64', kind: 'appimage', version: '2.0.0' })
  assert.deepEqual(await f.store.latest(target), first)
  await writeFile(f.file, 'replacement')
  await assert.rejects(f.publish(), { code: grpc.status.ALREADY_EXISTS })
  await assert.rejects(f.publish({ version: '1.2.2' }), { code: grpc.status.FAILED_PRECONDITION })
  assert.deepEqual(await f.store.latest(target), first)
  await f.publish({ version: '1.3.0' })
  await assert.rejects(collect(f.store.download({ ...target, version: first.version, sha256: first.sha256 })), { code: grpc.status.NOT_FOUND })
})

test('missing releases are normal and unsafe selectors or unstable versions are rejected', async t => {
  const f = await fixture(t)
  await assert.rejects(f.store.latest(target), { code: grpc.status.NOT_FOUND })
  for (const input of [
    { platform: '../win32' }, { arch: '../../secret' }, { kind: 'installer' },
    { platform: 'linux', arch: 'ia32', kind: 'appimage' },
  ]) await assert.rejects(f.store.latest({ ...target, ...input }), { code: grpc.status.INVALID_ARGUMENT })
  for (const version of ['1', 'v1.2.3', '1.2.3-beta', '01.2.3', '../1.2.3']) {
    await assert.rejects(f.publish({ version }), { code: grpc.status.INVALID_ARGUMENT })
  }
  await assert.rejects(collect(f.store.download({ ...target, version: '1.2.3', sha256: '../private' })), { code: grpc.status.INVALID_ARGUMENT })
})

test('failed publication leaves the previous manifest intact and rejects empty or oversized inputs', async t => {
  const f = await fixture(t)
  const first = await f.publish()
  const before = await readFile(path.join(f.directory, 'manifest.json'))
  await writeFile(f.file, '')
  await assert.rejects(f.publish({ version: '1.2.4' }), { code: grpc.status.INVALID_ARGUMENT })
  const huge = await open(f.file, 'w')
  await huge.truncate(2147483649)
  await huge.close()
  await assert.rejects(f.publish({ version: '1.2.4' }), { code: grpc.status.RESOURCE_EXHAUSTED })
  assert.deepEqual(await readFile(path.join(f.directory, 'manifest.json')), before)
  assert.deepEqual(await f.store.latest(target), first)
  assert.ok(!(await readdir(f.directory)).includes('.publish.lock'))
})

test('manifest paths, invalid hashes, excessive metadata and changed artifact sizes fail closed', async t => {
  const f = await fixture(t)
  await f.publish()
  const manifestPath = path.join(f.directory, 'manifest.json')
  const original = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const patch of [{ file: '../client.exe' }, { sha256: 'x'.repeat(64) }, { size: '2147483649' }, { name: '..\\escape.exe' }]) {
    const changed = structuredClone(original)
    Object.assign(changed.releases[0], patch)
    await writeFile(manifestPath, JSON.stringify(changed))
    await assert.rejects(f.store.latest(target), { code: grpc.status.FAILED_PRECONDITION })
  }
  await writeFile(manifestPath, ' '.repeat(65537))
  await assert.rejects(f.store.latest(target), { code: grpc.status.FAILED_PRECONDITION })
  await writeFile(manifestPath, JSON.stringify(original))
  await writeFile(path.join(f.directory, original.releases[0].file), 'short')
  await assert.rejects(f.store.latest(target), { code: grpc.status.FAILED_PRECONDITION })
})

test('downloads detect equal-size corruption and cancelled producers stop without emitting bytes', async t => {
  const f = await fixture(t, Buffer.from('original'))
  const release = await f.publish()
  const request = { ...target, version: release.version, sha256: release.sha256 }
  const controller = new AbortController()
  const iterator = f.store.download(request, { signal: controller.signal })
  assert.deepEqual((await iterator.next()).value, { release })
  controller.abort()
  assert.equal((await iterator.next()).done, true)
  const manifest = JSON.parse(await readFile(path.join(f.directory, 'manifest.json'), 'utf8'))
  await writeFile(path.join(f.directory, manifest.releases[0].file), 'tampered')
  await assert.rejects(collect(f.store.download(request)), { code: grpc.status.FAILED_PRECONDITION })
})

test('publisher lock prevents concurrent manifest replacement and is not removed by another publisher', async t => {
  const f = await fixture(t)
  const original = await f.publish()
  const lock = path.join(f.directory, '.publish.lock')
  await writeFile(lock, 'another publisher')
  await assert.rejects(f.publish({ version: '1.2.4' }), { code: grpc.status.FAILED_PRECONDITION })
  assert.equal(await readFile(lock, 'utf8'), 'another publisher')
  assert.deepEqual(await f.store.latest(target), original)
})

test('release artifact symlinks cannot expose files outside the release directory', async t => {
  const f = await fixture(t)
  const release = await f.publish()
  const manifest = JSON.parse(await readFile(path.join(f.directory, 'manifest.json'), 'utf8'))
  const artifact = path.join(f.directory, manifest.releases[0].file)
  await rm(artifact)
  try { await symlink(f.file, artifact, 'file') }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Windows symlinks need developer mode or privilege'); throw error }
  await assert.rejects(f.store.latest(target), { code: grpc.status.FAILED_PRECONDITION })
  await assert.rejects(collect(f.store.download({ ...target, version: release.version, sha256: release.sha256 })), { code: grpc.status.FAILED_PRECONDITION })
})

test('release publishing CLI operates without API credentials or database configuration', async t => {
  const f = await fixture(t)
  const result = await promisify(execFile)(process.execPath, [
    'scripts/publish-release.mjs', '--file', f.file, '--directory', f.directory,
    '--version', '3.2.1', '--platform', 'win32', '--arch', 'x64', '--kind', 'portable', '--notes', 'Ready',
  ], { cwd: new URL('..', import.meta.url) })
  assert.match(result.stdout, /3\.2\.1/)
  assert.equal((await f.store.latest(target)).notes, 'Ready')
})
