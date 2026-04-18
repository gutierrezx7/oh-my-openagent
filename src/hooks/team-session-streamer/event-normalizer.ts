import type { EventMessagePartUpdated } from "@opencode-ai/sdk"

import type { PendingStreamEvent } from "./pending-delta-buffer"

export type MessagePartDeltaEvent = {
  type: "message.part.delta"
  properties: {
    sessionID: string
    partID?: string
    field?: string
    delta: string
  }
}

export function normalizeUpdateEventForBuffer(event: EventMessagePartUpdated): PendingStreamEvent | undefined {
  const { part } = event.properties
  const cumulativeText = "text" in part && typeof part.text === "string" ? part.text : undefined
  if (cumulativeText === undefined) return undefined
  return { kind: "update", partID: part.id, cumulativeText }
}

export function normalizeDeltaEventForBuffer(event: MessagePartDeltaEvent): PendingStreamEvent | undefined {
  const { partID, field, delta } = event.properties
  if (typeof delta !== "string" || delta.length === 0) return undefined
  if (field !== undefined && field !== "text" && field !== "content") return undefined
  if (!partID) return undefined
  return { kind: "delta", partID, delta }
}
