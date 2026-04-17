import type { PendingStreamEvent } from "./pending-delta-buffer"

export type PendingEventPreview = {
  partKey: string
  nextState: string
  appendedText: string
}

export function previewPendingEvent(
  pending: PendingStreamEvent,
  sessionID: string,
  partTextByKey: Map<string, string>,
): PendingEventPreview | undefined {
  const partKey = `${sessionID}:${pending.partID}`
  const previousText = partTextByKey.get(partKey) ?? ""
  if (pending.kind === "delta") {
    return { partKey, nextState: previousText + pending.delta, appendedText: pending.delta }
  }
  const appendedText = pending.cumulativeText.startsWith(previousText)
    ? pending.cumulativeText.slice(previousText.length)
    : pending.cumulativeText
  if (appendedText.length === 0) return undefined
  return { partKey, nextState: pending.cumulativeText, appendedText }
}

export function clearSessionPartState(sessionID: string, partTextByKey: Map<string, string>): void {
  for (const partKey of partTextByKey.keys()) {
    if (partKey.startsWith(`${sessionID}:`)) {
      partTextByKey.delete(partKey)
    }
  }
}
