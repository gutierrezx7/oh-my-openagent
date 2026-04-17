export type PendingStreamEvent =
  | { kind: "delta"; partID: string; delta: string }
  | { kind: "update"; partID: string; cumulativeText: string }

export type PendingDeltaBuffer = {
  enqueue: (sessionID: string, entry: PendingStreamEvent) => void
  drain: (sessionID: string) => PendingStreamEvent[]
  clearSession: (sessionID: string) => void
  removePart: (sessionID: string, partID: string) => void
  getPendingSessions: () => string[]
}

export function createPendingDeltaBuffer(): PendingDeltaBuffer {
  const queuesBySession = new Map<string, PendingStreamEvent[]>()

  function enqueue(sessionID: string, entry: PendingStreamEvent): void {
    const queue = queuesBySession.get(sessionID) ?? []
    queue.push(entry)
    queuesBySession.set(sessionID, queue)
  }

  function drain(sessionID: string): PendingStreamEvent[] {
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

  function getPendingSessions(): string[] {
    return Array.from(queuesBySession.keys())
  }

  return { enqueue, drain, clearSession, removePart, getPendingSessions }
}
