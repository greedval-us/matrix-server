const maxManifest = 1024 * 1024
const maxFiles = 4096
const maxContent = 64 * 1024 ** 3
const maxRecord = 4 * 1024 * 1024
const maxDepth = 100
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const quote = 0x22, backslash = 0x5c, comma = 0x2c
const openObject = 0x7b, closeObject = 0x7d, openArray = 0x5b, closeArray = 0x5d

export class CatalogUploadError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

const invalidManifest = () => new CatalogUploadError('Некорректное описание загружаемых файлов.')
const tooLarge = () => new CatalogUploadError('Размер выбранных файлов превышает 64 ГиБ.', 413)
const invalidFile = name => new CatalogUploadError(`Файл «${name}» должен содержать объект JSON или непустой массив объектов в UTF-8.`)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// Retain only the current manifest or record, even with one-byte network chunks.
class ByteBuffer {
  constructor(limit, overflow) {
    this.limit = limit
    this.overflow = overflow
    this.bytes = Buffer.alloc(0)
    this.length = 0
  }

  append(part) {
    const needed = this.length + part.length
    if (needed > this.limit) throw this.overflow()
    if (needed > this.bytes.length) {
      const capacity = Math.min(this.limit, Math.max(needed, this.bytes.length * 2, 256))
      const next = Buffer.allocUnsafe(capacity)
      this.bytes.copy(next, 0, 0, this.length)
      this.bytes = next
    }
    part.copy(this.bytes, this.length)
    this.length = needed
  }

  take() {
    const result = this.bytes.subarray(0, this.length)
    this.length = 0
    return result
  }
}

class BodyReader {
  constructor(request) {
    this.iterator = request.iterator({ destroyOnReturn: false })
    this.bytes = Buffer.alloc(0)
  }

  async available() {
    while (!this.bytes.length) {
      const { value, done } = await this.iterator.next()
      if (done) return false
      this.bytes = value
    }
    return true
  }

  take(length) {
    const part = this.bytes.subarray(0, length)
    this.bytes = this.bytes.subarray(length)
    return part
  }

  async manifest() {
    const buffer = new ByteBuffer(maxManifest, () => new CatalogUploadError('Описание загрузки превышает 1 МиБ.', 413))
    while (await this.available()) {
      const end = this.bytes.indexOf(10)
      buffer.append(this.take(end < 0 ? this.bytes.length : end))
      if (end >= 0) {
        this.take(1)
        return buffer.take()
      }
    }
    throw invalidManifest()
  }

  async *file({ name, size }) {
    while (size > 0) {
      if (!await this.available()) throw new CatalogUploadError(`Загрузка файла «${name}» оборвалась.`)
      const part = this.take(Math.min(size, this.bytes.length))
      size -= part.length
      yield part
    }
  }
}

function parseManifest(bytes) {
  let manifest
  try { manifest = JSON.parse(utf8.decode(bytes)) } catch { throw invalidManifest() }
  if (!object(manifest) || !object(manifest.metadata) || !Array.isArray(manifest.files)
    || Object.keys(manifest).length !== 2 || !manifest.files.length) throw invalidManifest()
  if (manifest.files.length > maxFiles) throw new CatalogUploadError(`Выберите не более ${maxFiles} JSON-файлов.`, 413)
  let contentSize = 0
  for (const file of manifest.files) {
    if (!object(file) || Object.keys(file).length !== 2 || !Number.isSafeInteger(file.size) || file.size < 0
      || typeof file.name !== 'string' || !file.name.isWellFormed() || [...file.name].length > 255
      || /[/\\\p{Cc}\p{Cf}]/u.test(file.name) || !/\.json$/i.test(file.name)) throw invalidManifest()
    contentSize += file.size
    if (contentSize > maxContent) throw tooLarge()
  }
  return { ...manifest, contentSize }
}

function decodeRecord(bytes, name) {
  try {
    const text = utf8.decode(bytes)
    JSON.parse(text)
    return text
  } catch { throw invalidFile(name) }
}

async function* records(chunks, name) {
  const buffer = new ByteBuffer(maxRecord, () => new CatalogUploadError(`Запись в файле «${name}» превышает 4 МиБ.`, 413))
  let phase = 'start'
  let array = false
  let depth = 0
  let quoted = false
  let escaped = false
  let bom = 0
  let firstByte = true

  for await (const bytes of chunks) {
    let start = depth ? 0 : -1
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index]
      if (firstByte) {
        firstByte = false
        if (byte === 0xef) { bom = 1; continue }
      }
      if (bom) {
        if (byte !== (bom === 1 ? 0xbb : 0xbf)) throw invalidFile(name)
        bom = bom === 1 ? 2 : 0
        continue
      }
      if (depth) {
        if (quoted) {
          if (escaped) escaped = false
          else if (byte === backslash) escaped = true
          else if (byte === quote) quoted = false
        } else if (byte === quote) quoted = true
        else if (byte === openObject || byte === openArray) {
          if (++depth > maxDepth) throw new CatalogUploadError(`Запись в файле «${name}» превышает 100 уровней вложенности.`)
        } else if (byte === closeObject || byte === closeArray) {
          if (--depth === 0) {
            buffer.append(bytes.subarray(start, index + 1))
            start = -1
            phase = array ? 'separator' : 'end'
            yield decodeRecord(buffer.take(), name)
          }
        }
        continue
      }
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
      if (phase === 'start' && byte === openArray) {
        array = true
        phase = 'element'
      } else if ((phase === 'start' || phase === 'element') && byte === openObject) {
        start = index
        depth = 1
      } else if (phase === 'separator' && byte === comma) phase = 'element'
      else if (phase === 'separator' && byte === closeArray) phase = 'end'
      else throw invalidFile(name)
    }
    if (start !== -1) buffer.append(bytes.subarray(start))
  }
  if (phase !== 'end' || depth) throw invalidFile(name)
}

async function* readFiles(reader, descriptions) {
  try {
    for (const file of descriptions) {
      let complete = false
      async function* readRecords() {
        yield* records(reader.file(file), file.name)
        complete = true
      }
      yield { name: file.name, records: readRecords() }
      if (!complete) throw new CatalogUploadError(`Чтение файла «${file.name}» не завершено.`)
    }
    if (await reader.available()) throw new CatalogUploadError('После последнего файла обнаружены лишние данные.')
  } finally {
    await reader.iterator.return()
  }
}

export async function readImportUpload(request) {
  const mime = (request.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (mime !== 'application/octet-stream') throw new CatalogUploadError('Требуется двоичная загрузка папки с JSON-файлами.', 415)
  const length = request.headers['content-length']
  if (length !== undefined && Number(length) > maxManifest + 1 + maxContent) throw tooLarge()
  const reader = new BodyReader(request)
  try {
    const bytes = await reader.manifest()
    const { metadata, files, contentSize } = parseManifest(bytes)
    if (length !== undefined && Number(length) !== bytes.length + 1 + contentSize) {
      throw new CatalogUploadError('Размер запроса не совпадает с описанием файлов.')
    }
    return { metadata, files: readFiles(reader, files) }
  } catch (error) {
    await reader.iterator.return()
    throw error
  }
}
