import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import test from 'node:test'
import { sendStream, writeStream } from '../node/core/streams.mjs'
import { RecordsService } from '../node/modules/records/service.mjs'

function output({ writable = true } = {}) {
  return Object.assign(new EventEmitter(), {
    messages: [], ended: false,
    write(value) { this.messages.push(value); return writable },
    end() { this.ended = true },
  })
}

test('backpressure waits for drain and removes temporary listeners', async () => {
  const call = output({ writable: false })
  let settled = false
  const pending = writeStream(call, { value: 1 }).then(result => { settled = true; return result })
  await Promise.resolve()
  assert.equal(settled, false)
  call.emit('drain')
  assert.equal(await pending, true)
  assert.deepEqual(call.eventNames(), [])
  assert.deepEqual(call.messages, [{ value: 1 }])
})

for (const event of ['cancelled', 'close', 'error']) {
  test(`backpressure stops on ${event} without leaking listeners`, async () => {
    const call = output({ writable: false })
    const pending = writeStream(call, {})
    call.emit(event, new Error('transport disconnected'))
    assert.equal(await pending, false)
    assert.deepEqual(call.eventNames(), [])
  })
}

test('synchronous output close or write failure cannot strand a producer or leave listeners', async () => {
  const closed = output()
  closed.write = () => { closed.emit('close'); return false }
  assert.equal(await writeStream(closed, {}), false)
  assert.deepEqual(closed.eventNames(), [])
  const failed = output()
  failed.write = () => { throw new Error('write failed') }
  await assert.rejects(writeStream(failed, {}), { message: 'write failed' })
  assert.deepEqual(failed.eventNames(), [])
})

test('closing a blocked stream releases its generator without pulling another result', async () => {
  const call = output({ writable: false })
  let released = false
  let signal
  const pending = sendStream(call, async function* (options) {
    signal = options.signal
    try {
      yield { first: true }
      assert.fail('closed output pulled another message')
    } finally { released = true }
  })
  await new Promise(resolve => setImmediate(resolve))
  call.emit('close')
  await pending
  assert.equal(signal.aborted, true)
  assert.equal(released, true)
  assert.equal(call.ended, false)
  assert.deepEqual(call.eventNames(), [])
})

test('cancellation aborts a pending producer and is not a request failure', async () => {
  const call = output()
  const pending = sendStream(call, async function* ({ signal }) {
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    assert.fail('cancelled producer completed')
  })
  call.emit('cancelled')
  await pending
  assert.equal(call.ended, false)
  assert.deepEqual(call.eventNames(), [])
})

test('producer errors propagate to the RPC boundary and successful streams end once', async () => {
  const failed = output()
  const error = new Error('private dependency detail')
  await assert.rejects(sendStream(failed, async function* () { throw error }), value => value === error)
  assert.equal(failed.ended, false)
  assert.deepEqual(failed.eventNames(), [])
  const call = output()
  await sendStream(call, async function* () { yield 1; yield 2 })
  assert.deepEqual(call.messages, [1, 2])
  assert.equal(call.ended, true)
  assert.deepEqual(call.eventNames(), [])
})

test('an attachment download closes its source when output closes under backpressure', async () => {
  const source = Readable.from([Buffer.from('abc')])
  const service = new RecordsService(
    { getFile: async () => ({ id: 'file', size: '3' }) },
    { open: async () => source },
  )
  const call = output({ writable: false })
  call.request = { row_id: '1', file_id: 'file' }
  const pending = service.download(call)
  await new Promise(resolve => setImmediate(resolve))
  call.emit('close')
  await pending
  assert.equal(source.destroyed, true)
  assert.equal(call.ended, false)
  assert.deepEqual(call.eventNames(), [])
})
