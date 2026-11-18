import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'

export const MAX_RELEASE_BYTES = 2 * 1024 * 1024 * 1024
export const RELEASE_CHUNK_BYTES = 256 * 1024
const MAX_MANIFEST_BYTES = 64 * 1024
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/
const HASH = /^[0-9a-f]{64}$/
const invalid = () => new ApplicationError(grpc.status.INVALID_ARGUMENT, 'Invalid application release selector or metadata')
const invalidStorage = () => new ApplicationError(grpc.status.FAILED_PRECONDITION, 'Published application release is invalid')
const missing = () => new ApplicationError(grpc.status.NOT_FOUND, 'Application release is not published')
export const releaseError = error => error instanceof ApplicationError ? error
  : error.code === 'ENOENT' ? missing() : invalidStorage()

export function validateTarget(value) {
  const { platform, arch, kind } = value ?? {}
  if (!(platform === 'win32' && ['x64', 'arm64', 'ia32'].includes(arch) && kind === 'portable')
    && !(platform === 'linux' && ['x64', 'arm64'].includes(arch) && kind === 'appimage')) throw invalid()
  return { platform, arch, kind }
}

export function validateVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) throw invalid()
  return value
}

export function validateNotes(value = '') {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8000 || value.includes('\0')) throw invalid()
  return value
}

export const targetKey = value => `${value.platform}/${value.arch}/${value.kind}`
export const releaseName = value => `model 404.${value.kind === 'portable' ? 'exe' : 'AppImage'}`
// Existing manifests keep their original public names, including cached download headers.
const legacyReleaseName = value => `Matrix-${value.version}-${value.platform}-${value.arch}-${value.kind}.${value.kind === 'portable' ? 'exe' : 'AppImage'}`
export const artifactName = value => `${value.version}-${value.platform}-${value.arch}-${value.kind}-${value.sha256}.bin`
export function publicRelease({ file: _file, ...release }) { return release }

export async function verifyDirectory(directory) {
  const info = await lstat(directory)
  const actual = await realpath(directory)
  const same = process.platform === 'win32' ? actual.toLowerCase() === directory.toLowerCase() : actual === directory
  if (!info.isDirectory() || info.isSymbolicLink() || !same) throw invalidStorage()
}

// Open only a regular file. O_NOFOLLOW plus the identity comparison also covers
// platforms where O_NOFOLLOW is unavailable. The deployment owns this directory.
export async function openRegular(filename) {
  let handle
  try {
    const before = await lstat(filename)
    if (!before.isFile() || before.isSymbolicLink()) throw invalidStorage()
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const after = await handle.stat()
    if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) throw invalidStorage()
    return { handle, info: after }
  } catch (error) { await handle?.close(); throw error }
}

function validateEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidStorage()
  validateTarget(value)
  validateVersion(value.version)
  validateNotes(value.notes)
  const keys = ['version', 'platform', 'arch', 'kind', 'name', 'size', 'sha256', 'published_at', 'notes', 'file']
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))
    || typeof value.size !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value.size)
    || Number(value.size) > MAX_RELEASE_BYTES || !HASH.test(value.sha256)
    || (value.name !== releaseName(value) && value.name !== legacyReleaseName(value)) || value.file !== artifactName(value)
    || typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))
    || new Date(value.published_at).toISOString() !== value.published_at) throw invalidStorage()
  return value
}

export async function readManifest(directory, { allowMissing = false } = {}) {
  let handle
  try {
    await verifyDirectory(directory)
    let opened
    try { opened = await openRegular(path.join(directory, 'manifest.json')) }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return { schema: 1, releases: [] }; throw error }
    handle = opened.handle
    if (opened.info.size > MAX_MANIFEST_BYTES) throw invalidStorage()
    // The bounded read also handles an unexpectedly growing manifest.
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1)
    let received = 0
    while (received < bytes.length) {
      const { bytesRead } = await handle.read(bytes, received, bytes.length - received, received)
      if (!bytesRead) break
      received += bytesRead
    }
    if (received > MAX_MANIFEST_BYTES) throw invalidStorage()
    const manifest = JSON.parse(bytes.subarray(0, received).toString('utf8'))
    if (manifest.schema !== 1 || !Array.isArray(manifest.releases) || manifest.releases.length > 5) throw invalidStorage()
    const targets = new Set()
    for (const entry of manifest.releases) {
      validateEntry(entry)
      const key = targetKey(entry)
      if (targets.has(key)) throw invalidStorage()
      targets.add(key)
    }
    return manifest
  } catch (error) {
    if (error.code === 'ENOENT') throw missing()
    throw invalidStorage()
  } finally { await handle?.close() }
}

export class ReleaseStore {
  constructor(directory) { this.directory = path.resolve(directory) }

  async find(target) {
    validateTarget(target)
    const manifest = await readManifest(this.directory)
    const release = manifest.releases.find(candidate => targetKey(candidate) === targetKey(target))
    if (!release) throw missing()
    return release
  }

  async openArtifact(release) {
    let opened
    try {
      await verifyDirectory(this.directory)
      opened = await openRegular(path.join(this.directory, release.file))
      if (opened.info.size !== Number(release.size)) throw invalidStorage()
      return opened.handle
    } catch (error) { await opened?.handle.close(); throw releaseError(error) }
  }

  async latest(target) {
    const release = await this.find(target)
    const handle = await this.openArtifact(release)
    await handle.close()
    return publicRelease(release)
  }

  async *download(request, { signal } = {}) {
    validateTarget(request)
    validateVersion(request.version)
    if (typeof request.sha256 !== 'string' || !HASH.test(request.sha256)) throw invalid()
    if (signal?.aborted) return
    const release = await this.find(request)
    if (release.version !== request.version || release.sha256 !== request.sha256) throw missing()
    const handle = await this.openArtifact(release)
    try {
      if (signal?.aborted) return
      yield { release: publicRelease(release) }
      let received = 0
      const hash = createHash('sha256')
      while (!signal?.aborted) {
        const bytes = Buffer.allocUnsafe(RELEASE_CHUNK_BYTES)
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, null)
        if (signal?.aborted) return
        if (!bytesRead) break
        received += bytesRead
        if (received > Number(release.size)) throw invalidStorage()
        const data = bytes.subarray(0, bytesRead)
        hash.update(data)
        yield { data }
      }
      if (signal?.aborted) return
      if (received !== Number(release.size) || hash.digest('hex') !== release.sha256) throw invalidStorage()
    } catch (error) { throw releaseError(error) }
    finally { await handle.close() }
  }
}
