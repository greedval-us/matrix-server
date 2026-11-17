import { createHash, randomUUID } from 'node:crypto'
import { link, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'
import {
  MAX_RELEASE_BYTES, RELEASE_CHUNK_BYTES, artifactName, openRegular, publicRelease,
  readManifest, releaseError, releaseName, targetKey, validateNotes, validateTarget,
  validateVersion, verifyDirectory,
} from './store.mjs'

function compareVersions(a, b) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}

async function digestFile(filename) {
  const { handle } = await openRegular(filename)
  try {
    const hash = createHash('sha256')
    for (;;) {
      const bytes = Buffer.allocUnsafe(RELEASE_CHUNK_BYTES)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, null)
      if (!bytesRead) return hash.digest('hex')
      hash.update(bytes.subarray(0, bytesRead))
    }
  } finally { await handle.close() }
}

export async function publishRelease({ directory, file, version, platform, arch, kind, notes = '' }) {
  const target = validateTarget({ platform, arch, kind })
  validateVersion(version)
  validateNotes(notes)
  if (typeof directory !== 'string' || !directory || typeof file !== 'string' || !file) {
    throw new ApplicationError(grpc.status.INVALID_ARGUMENT, 'Release source and directory are required')
  }
  const root = path.resolve(directory)
  const lockPath = path.join(root, '.publish.lock')
  const artifactTemp = path.join(root, `.${randomUUID()}.tmp`)
  const manifestTemp = path.join(root, `.${randomUUID()}.tmp`)
  let lock, source, destination, manifestHandle
  try {
    await mkdir(root, { recursive: true, mode: 0o755 })
    await verifyDirectory(root)
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch (error) {
      if (error.code === 'EEXIST') throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Another release publication is in progress; inspect the publication lock')
      throw error
    }
    const manifest = await readManifest(root, { allowMissing: true })
    const previous = manifest.releases.find(candidate => targetKey(candidate) === targetKey(target))
    if (previous && compareVersions(version, previous.version) < 0) {
      throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'A newer application version is already published')
    }
    const opened = await openRegular(path.resolve(file))
    source = opened.handle
    if (!opened.info.size) throw new ApplicationError(grpc.status.INVALID_ARGUMENT, 'Release source must not be empty')
    if (opened.info.size > MAX_RELEASE_BYTES) throw new ApplicationError(grpc.status.RESOURCE_EXHAUSTED, 'Application release exceeds 2 GiB')
    destination = await open(artifactTemp, 'wx', 0o644)
    const hash = createHash('sha256')
    let size = 0
    for (;;) {
      const bytes = Buffer.allocUnsafe(RELEASE_CHUNK_BYTES)
      const { bytesRead } = await source.read(bytes, 0, bytes.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > MAX_RELEASE_BYTES) throw new ApplicationError(grpc.status.RESOURCE_EXHAUSTED, 'Application release exceeds 2 GiB')
      const data = bytes.subarray(0, bytesRead)
      hash.update(data)
      await destination.writeFile(data)
    }
    const after = await source.stat()
    if (size !== opened.info.size || after.size !== opened.info.size || after.mtimeMs !== opened.info.mtimeMs) {
      throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Release source changed during publication')
    }
    await destination.sync()
    await destination.close(); destination = undefined
    await source.close(); source = undefined
    const release = { version, ...target, name: releaseName({ version, ...target }), size: String(size), sha256: hash.digest('hex'), published_at: new Date().toISOString(), notes }
    const artifact = path.join(root, artifactName(release))
    if (previous?.version === version) {
      if (previous.sha256 !== release.sha256) throw new ApplicationError(grpc.status.ALREADY_EXISTS, 'An application version cannot be replaced with different bytes')
      if (await digestFile(artifact) !== release.sha256) throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Existing application artifact failed verification')
      return publicRelease(previous)
    }
    // Hard-link a fully synced temporary file: publishing never overwrites an
    // immutable artifact, even if an interrupted run already created its name.
    try { await link(artifactTemp, artifact) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (await digestFile(artifact) !== release.sha256) throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Existing application artifact failed verification')
    }
    const entry = { ...release, file: artifactName(release) }
    const releases = [...manifest.releases.filter(candidate => targetKey(candidate) !== targetKey(target)), entry]
    manifestHandle = await open(manifestTemp, 'wx', 0o644)
    await manifestHandle.writeFile(`${JSON.stringify({ schema: 1, releases }, null, 2)}\n`)
    await manifestHandle.sync()
    await manifestHandle.close(); manifestHandle = undefined
    await rename(manifestTemp, path.join(root, 'manifest.json'))
    return release
  } catch (error) { throw releaseError(error) }
  finally {
    await Promise.allSettled([source?.close(), destination?.close(), manifestHandle?.close()])
    await Promise.allSettled([unlink(artifactTemp), unlink(manifestTemp)])
    if (lock) { await lock.close(); await unlink(lockPath) }
  }
}
