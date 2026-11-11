const terminalEvents = ['cancelled', 'close', 'error']
const writable = call => !call.cancelled && !call.destroyed && !call.writableEnded

export async function writeStream(call, message) {
  if (!writable(call)) return false

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      call.off('drain', drained)
      for (const event of terminalEvents) call.off(event, stopped)
    }
    const finish = result => { cleanup(); resolve(result) }
    const drained = () => finish(writable(call))
    const stopped = () => finish(false)
    call.once('drain', drained)
    for (const event of terminalEvents) call.once(event, stopped)
    try {
      if (call.write(message)) finish(writable(call))
      else if (!writable(call)) finish(false)
    } catch (error) { cleanup(); reject(error) }
  })
}

// The transport owns output lifecycle; producers receive only an AbortSignal.
export async function sendStream(call, messages) {
  if (!writable(call)) return
  const controller = new AbortController()
  const stop = () => controller.abort()
  for (const event of terminalEvents) call.once(event, stop)
  try {
    for await (const message of messages({ signal: controller.signal })) {
      if (controller.signal.aborted || !await writeStream(call, message)) return
    }
    if (!controller.signal.aborted && writable(call)) call.end()
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    for (const event of terminalEvents) call.off(event, stop)
    controller.abort()
  }
}
