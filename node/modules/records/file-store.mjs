import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'

const MAX_UINT64 = 18446744073709551615n
const CHUNK_BYTES = 65536
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CONTROL_CHARACTERS = /\p{Cc}/u

const invalid = (message) => new ApplicationError(grpc.status.INVALID_ARGUMENT, message)
const exhausted = (message) => new ApplicationError(grpc.status.RESOURCE_EXHAUSTED, message)
const cancelled = () => new ApplicationError(grpc.status.CANCELLED, 'File upload cancelled')
const unavailable = (error) => error instanceof ApplicationError
  ? error : new ApplicationError(grpc.status.INTERNAL, 'File storage operation failed')

function uint64(value, label, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value)) {
    throw invalid(`Invalid ${label}`)
  }
  const number = BigInt(value)
  if (number > MAX_UINT64 || (positive && number === 0n)) throw invalid(`Invalid ${label}`)
  return number
}

function fileId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('Invalid file ID')
  return value.toLowerCase()
}

function displayName(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) throw invalid('Invalid file name')
  // Browsers and native clients may supply either platform's source path.
  // Only a display basename survives; content paths are always generated UUIDs.
  const name = path.posix.basename(path.win32.basename(value))
  if (!name.trim() || name === '.' || name === '..' || name.includes(':') || [...name].length > 255) {
    throw invalid('Invalid file name')
  }
  return name
}

function mimeType(value) {
  if (value === undefined || value === '') return 'application/octet-stream'
  if (typeof value !== 'string' || value.length > 255 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value)) {
    throw invalid('Invalid file MIME type')
  }
  return value
}

function limit(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw invalid(`Invalid ${label}`)
  return value
}

function checkCancellation(signal) {
  if (signal?.aborted) throw cancelled()
}

async function nextChunk(iterator, signal) {
  checkCancellation(signal)
  if (!signal) return iterator.next()
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(cancelled()) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) return onAbort()
    Promise.resolve().then(() => iterator.next()).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function readableFromHandle(handle) {
  return new Readable({
    highWaterMark: CHUNK_BYTES,
    read() {
      const stream = this
      void (async () => {
        try {
          const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
          if (!stream.destroyed) stream.push(bytesRead ? buffer.subarray(0, bytesRead) : null)
        } catch (error) { stream.destroy(unavailable(error)) }
      })()
    },
    destroy(error, callback) {
      handle.close().then(
        () => callback(error ? unavailable(error) : null),
        (closeError) => callback(unavailable(error ?? closeError)),
      )
    },
  })
}

export class ControlFileStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !directory || directory.includes('\0')) {
      throw invalid('Invalid file storage directory')
    }
    this.directory = path.resolve(directory)
  }

  async ensureDirectory() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'File storage directory is invalid')
    }
  }

  async receiveUploads(source, {
    maxFileBytes = 26214400, maxBatchBytes = 104857600, maxFiles = 20, signal,
  } = {}) {
    const ownedPaths = new Set()
    const metadata = []
    let iterator
    let current
    let rowId
    let declaredBatchBytes = 0n
    let sourceComplete = false
    const finishFile = async () => {
      if (!current) return
      if (current.written !== current.size) throw invalid('File data does not match its declared size')
      checkCancellation(signal)
      await current.handle.close()
      current.handle = null
      // The directory is private; never intentionally replace an existing UUID.
      try {
        await lstat(current.finalPath)
        throw new ApplicationError(grpc.status.ALREADY_EXISTS, 'File ID collision')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      await rename(current.tempPath, current.finalPath)
      ownedPaths.delete(current.tempPath)
      ownedPaths.add(current.finalPath)
      metadata.push(current.metadata)
      current = null
    }
    try {
      limit(maxFileBytes, 'file byte limit')
      limit(maxBatchBytes, 'batch byte limit')
      limit(maxFiles, 'file count limit', 1)
      checkCancellation(signal)
      if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw invalid('Invalid file upload stream')
      iterator = source[Symbol.asyncIterator]()
      await this.ensureDirectory()
      while (true) {
        const result = await nextChunk(iterator, signal)
        checkCancellation(signal)
        if (result.done) { sourceComplete = true; break }
        const frame = result.value
        const isHeader = frame && Object.hasOwn(frame, 'header')
        const isData = frame && Object.hasOwn(frame, 'data')
        if (!frame || typeof frame !== 'object' || isHeader === isData ||
          (frame.chunk !== undefined && frame.chunk !== (isHeader ? 'header' : 'data'))) {
          throw invalid('Invalid file upload frame')
        }
        if (isHeader) {
          await finishFile()
          if (metadata.length >= maxFiles) throw exhausted('Too many files in upload batch')
          const header = frame.header
          if (!header || typeof header !== 'object') throw invalid('Invalid file upload header')
          uint64(header.row_id, 'row ID', true)
          if (rowId !== undefined && rowId !== header.row_id) throw invalid('Upload batch must use one row ID')
          rowId = header.row_id
          const size = uint64(header.size, 'file size')
          if (size > BigInt(maxFileBytes)) throw exhausted('File exceeds upload byte limit')
          declaredBatchBytes += size
          if (declaredBatchBytes > BigInt(maxBatchBytes)) throw exhausted('Upload batch exceeds byte limit')
          const id = randomUUID()
          const file = { id, name: displayName(header.name), size: header.size, mime_type: mimeType(header.mime_type) }
          const tempPath = path.join(this.directory, `.${id}.${randomUUID()}.part`)
          const handle = await open(tempPath, 'wx', 0o600)
          ownedPaths.add(tempPath)
          current = { handle, tempPath, finalPath: path.join(this.directory, id), metadata: file, size, written: 0n }
        } else {
          if (!current || !Buffer.isBuffer(frame.data)) throw invalid('File data must follow a header')
          if (frame.data.length > CHUNK_BYTES) throw exhausted('File data chunk exceeds byte limit')
          if (current.written + BigInt(frame.data.length) > current.size) {
            throw invalid('File data exceeds its declared size')
          }
          let offset = 0
          while (offset < frame.data.length) {
            checkCancellation(signal)
            const { bytesWritten } = await current.handle.write(frame.data, offset, frame.data.length - offset, null)
            if (bytesWritten === 0) throw new ApplicationError(grpc.status.INTERNAL, 'File write did not complete')
            offset += bytesWritten
          }
          current.written += BigInt(frame.data.length)
        }
      }
      await finishFile()
      if (!metadata.length) throw invalid('Upload batch must contain a file')
      checkCancellation(signal)
      return metadata
    } catch (error) {
      if (current?.handle) {
        try { await current.handle.close() } catch { /* Continue removing every owned artifact. */ }
      }
      await Promise.allSettled([...ownedPaths].map((ownedPath) => unlink(ownedPath)))
      throw unavailable(error)
    } finally {
      if (iterator && !sourceComplete && typeof iterator.return === 'function') {
        // A blocked async generator may not settle return() until its pending
        // next() completes. Request release without delaying abort cleanup.
        try { void Promise.resolve(iterator.return()).catch(() => {}) } catch { /* Source already failed. */ }
      }
    }
  }

  async open(value) {
    const id = fileId(value)
    let handle
    try {
      await this.ensureDirectory()
      const filename = path.join(this.directory, id)
      const before = await lstat(filename)
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'File content is invalid')
      }
      handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const after = await handle.stat()
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) {
        throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'File content changed while opening')
      }
      return readableFromHandle(handle)
    } catch (error) {
      if (handle) { try { await handle.close() } catch { /* Preserve the safe operation error. */ } }
      if (error.code === 'ENOENT') throw new ApplicationError(grpc.status.NOT_FOUND, 'File content not found')
      if (error.code === 'ELOOP') throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'File content is invalid')
      throw unavailable(error)
    }
  }

  async remove(value) {
    const id = fileId(value)
    try {
      await this.ensureDirectory()
      const filename = path.join(this.directory, id)
      const info = await lstat(filename)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new ApplicationError(grpc.status.FAILED_PRECONDITION, 'File content is invalid')
      }
      await unlink(filename)
    } catch (error) {
      if (error.code !== 'ENOENT') throw unavailable(error)
    }
  }

  async discard(metadata) {
    if (!Array.isArray(metadata)) throw invalid('Invalid file metadata')
    const ids = metadata.map((file) => fileId(file?.id))
    const results = await Promise.allSettled(ids.map((id) => this.remove(id)))
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}
