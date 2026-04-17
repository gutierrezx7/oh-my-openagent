export type PendingDelta = {
  partID: string
  delta: string
}

export type PendingDeltaBuffer = {
  enqueue: (sessionID: string, entry: PendingDelta) => void
  drain: (sessionID: string) => PendingDelta[]
  clearSession: (sessionID: string) => void
  removePart: (sessionID: string, partID: string) => void
}

export function createPendingDeltaBuffer(): PendingDeltaBuffer {
  const queuesBySession = new Map<string, PendingDelta[]>()

  function enqueue(sessionID: string, entry: PendingDelta): void {
    const queue = queuesBySession.get(sessionID) ?? []
    queue.push(entry)
    queuesBySession.set(sessionID, queue)
  }

  function drain(sessionID: string): PendingDelta[] {
    const queue = queuesBySession.get(sessionID)
    if (!queue) return []
    queuesBySession.delete(sessionID)
    return queue
  }

  function clearSession(sessionID: string): void {
    queuesBySession.delete(sessionID)
  }

  function removePart(sessionID: string, partID: string): void {
    const queue = queuesBySession.get(sessionID)
    if (!queue) return
    const filtered = queue.filter((entry) => entry.partID !== partID)
    if (filtered.length === 0) queuesBySession.delete(sessionID)
    else queuesBySession.set(sessionID, filtered)
  }

  return { enqueue, drain, clearSession, removePart }
}
