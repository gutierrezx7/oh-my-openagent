export async function runExclusiveDrain(
  sessionID: string,
  inFlight: Set<string>,
  drainOnce: () => Promise<boolean>,
  hasPending: () => boolean,
): Promise<boolean> {
  if (inFlight.has(sessionID)) return true
  inFlight.add(sessionID)
  try {
    while (true) {
      const ok = await drainOnce()
      if (!ok) return false
      if (!hasPending()) return true
    }
  } finally {
    inFlight.delete(sessionID)
  }
}
