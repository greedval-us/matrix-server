export function createAuditLog(repository, { warn = message => console.warn(message), maximumPending = 1000 } = {}) {
  const pending = new Set()
  return {
    record(metadata) {
      if (!repository) return
      if (pending.size >= maximumPending) { warn('[matrix] operational log queue is full'); return }
      const operation = Promise.resolve().then(() => repository.appendLog(metadata))
        .catch(() => warn('[matrix] could not persist request metadata'))
        .finally(() => pending.delete(operation))
      pending.add(operation)
    },
    async close() { await Promise.allSettled([...pending]) },
  }
}
