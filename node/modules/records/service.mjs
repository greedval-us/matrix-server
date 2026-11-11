import grpc from '@grpc/grpc-js'
import { ApplicationError } from '../../core/errors.mjs'
import { writeStream } from '../../core/streams.mjs'

const cancelled = () => new ApplicationError(grpc.status.CANCELLED, 'File transfer cancelled')

async function nextFrame(iterator, signal) {
  if (signal.aborted) throw cancelled()
  let abort
  const interruption = new Promise((_, reject) => { abort = () => reject(cancelled()); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([iterator.next(), interruption]) }
  finally { signal.removeEventListener('abort', abort) }
}

export class RecordsService {
  constructor(repository, fileStore, { warn = message => console.warn(message) } = {}) {
    this.repository = repository
    this.fileStore = fileStore
    this.warn = warn
  }

  capabilities() {
    return { available: true, list: true, upload: true, download: true, remove: true, create: true, update: true, delete: true, message: '' }
  }

  async upload(call) {
    const controller = new AbortController()
    const cancel = () => controller.abort()
    call.once('cancelled', cancel)
    if (call.cancelled || call.destroyed) cancel()
    let files = []
    let rowId
    let metadataAttempted = false
    try {
      const iterator = call[Symbol.asyncIterator]()
      const first = await nextFrame(iterator, controller.signal)
      if (first.done || !first.value.header) throw new ApplicationError(grpc.status.INVALID_ARGUMENT, 'Upload must begin with a file header')
      rowId = first.value.header.row_id
      await this.repository.get(rowId)
      async function* replay() {
        yield first.value
        while (true) {
          const frame = await nextFrame(iterator, controller.signal)
          if (frame.done) return
          yield frame.value
        }
      }
      files = await this.fileStore.receiveUploads(replay(), { signal: controller.signal })
      if (controller.signal.aborted) throw cancelled()
      metadataAttempted = true
      await this.repository.addFiles(rowId, files)
      return { files }
    } catch (error) {
      let disposable = files
      if (metadataAttempted && files.length && error.metadataRolledBack !== true) {
        // An MVCC read may still see pre-COMMIT data while an uncertain COMMIT
        // is in flight. Retain content until maintenance can establish the
        // final outcome under an explicit database/transaction barrier.
        disposable = []
        this.warn('[matrix:records] upload outcome requires metadata reconciliation')
      }
      if (disposable.length) {
        try { await this.fileStore.discard(disposable) }
        catch { this.warn('[matrix:records] could not clean unreferenced upload content') }
      }
      throw error
    } finally { call.off('cancelled', cancel) }
  }

  async download(call) {
    const { row_id: rowId, file_id: fileId } = call.request
    const file = await this.repository.getFile(rowId, fileId)
    const source = await this.fileStore.open(file.id)
    const cancel = () => source.destroy()
    call.once('cancelled', cancel)
    try {
      if (!await writeStream(call, { file })) return
      let received = 0n
      for await (const chunk of source) {
        received += BigInt(chunk.length)
        if (received > BigInt(file.size)) throw new ApplicationError(grpc.status.INTERNAL, 'Stored attachment size mismatch')
        if (!await writeStream(call, { data: chunk })) return
      }
      if (!call.cancelled && !call.destroyed) {
        if (received !== BigInt(file.size)) throw new ApplicationError(grpc.status.INTERNAL, 'Stored attachment size mismatch')
        call.end()
      }
    } finally { call.off('cancelled', cancel); source.destroy() }
  }

  async remove({ row_id: rowId, file_id: fileId }) {
    const file = await this.repository.removeFile(rowId, fileId)
    // Metadata is authoritative. A filesystem error must not restore a visible
    // reference to content another request may already have removed.
    try { await this.fileStore.remove(file.id) }
    catch { this.warn('[matrix:records] detached attachment content requires cleanup') }
    return { deleted: true }
  }
}
