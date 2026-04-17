import type { Event } from "@opencode-ai/sdk"

import type { TeamModeConfig } from "../../config/schema/team-mode"
import { getTeamMemberFifoPath } from "../../features/team-mode/team-layout-tmux/fifo-path"
import * as teamStateStore from "../../features/team-mode/team-state-store"
import { log } from "../../shared/logger"
import { clearSessionPartState, previewPendingEvent } from "./apply-pending-event"
import { type MessagePartDeltaEvent, normalizeDeltaEventForBuffer, normalizeUpdateEventForBuffer } from "./event-normalizer"
import { writeTeamSessionFifo } from "./fifo-writer"
import { createPendingDeltaBuffer, type PendingStreamEvent } from "./pending-delta-buffer"

type TeamStateStore = Pick<typeof teamStateStore, "listActiveTeams" | "loadRuntimeState">

type StreamEvent = Event | MessagePartDeltaEvent

type TeamSessionStreamTarget = {
  teamRunId: string
  memberName: string
  fifoPath: string
}

type HookInput = { event: StreamEvent }
type HookImpl = { event: (input: HookInput) => Promise<void>; dispose: () => void }

const DROPPABLE_FIFO_ERROR_CODES = new Set(["ENXIO", "ENOENT", "EPIPE"])
const PENDING_RESOLVE_RETRY_MS = 250

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

export function createTeamSessionStreamer(config: TeamModeConfig, stateStore: TeamStateStore): HookImpl {
  const streamTargetsBySession = new Map<string, TeamSessionStreamTarget>()
  const partTextByKey = new Map<string, string>()
  const pendingDeltaBuffer = createPendingDeltaBuffer()
  let pendingRetryTimer: ReturnType<typeof setTimeout> | undefined

  async function resolveStreamTarget(sessionID: string): Promise<TeamSessionStreamTarget | undefined> {
    const cachedTarget = streamTargetsBySession.get(sessionID)
    if (cachedTarget) return cachedTarget

    const activeTeams = await stateStore.listActiveTeams(config)
    for (const activeTeam of activeTeams) {
      try {
        const runtimeState = await stateStore.loadRuntimeState(activeTeam.teamRunId, config)
        const member = runtimeState.members.find((candidate) => candidate.sessionId === sessionID)
        if (!member) continue

        const target = {
          teamRunId: runtimeState.teamRunId,
          memberName: member.name,
          fifoPath: getTeamMemberFifoPath(runtimeState.teamRunId, member.name),
        }
        streamTargetsBySession.set(sessionID, target)
        return target
      } catch (error) {
        log("team session streamer skipped runtime", {
          event: "team-mode-session-streamer-runtime-error",
          teamRunId: activeTeam.teamRunId,
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return undefined
  }

  async function writeSegment(target: TeamSessionStreamTarget, sessionID: string, text: string): Promise<boolean> {
    try {
      await writeTeamSessionFifo(target.fifoPath, text)
      return true
    } catch (error) {
      if (isErrorWithCode(error) && DROPPABLE_FIFO_ERROR_CODES.has(error.code)) {
        if (error.code === "ENOENT") {
          streamTargetsBySession.delete(sessionID)
        }
        return false
      }

      log("team session streamer write failed", {
        event: "team-mode-session-streamer-write-error",
        teamRunId: target.teamRunId,
        memberName: target.memberName,
        sessionID,
        fifoPath: target.fifoPath,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  async function writePendingEvent(
    target: TeamSessionStreamTarget,
    sessionID: string,
    pending: PendingStreamEvent,
  ): Promise<boolean> {
    const preview = previewPendingEvent(pending, sessionID, partTextByKey)
    if (!preview) return true
    const written = await writeSegment(target, sessionID, preview.appendedText)
    if (written) partTextByKey.set(preview.partKey, preview.nextState)
    else pendingDeltaBuffer.enqueue(sessionID, pending)
    return written
  }

  async function flushPending(target: TeamSessionStreamTarget, sessionID: string): Promise<void> {
    const drained = pendingDeltaBuffer.drain(sessionID)
    for (const pending of drained) {
      const written = await writePendingEvent(target, sessionID, pending)
      if (!written) break
    }
  }

  async function retryPendingResolutions(): Promise<void> {
    pendingRetryTimer = undefined
    const sessions = pendingDeltaBuffer.getPendingSessions()
    for (const pendingSessionID of sessions) {
      const target = await resolveStreamTarget(pendingSessionID)
      if (target) await flushPending(target, pendingSessionID)
    }
    if (pendingDeltaBuffer.getPendingSessions().length > 0) schedulePendingRetry()
  }

  function schedulePendingRetry(): void {
    if (pendingRetryTimer) return
    pendingRetryTimer = setTimeout(() => {
      void retryPendingResolutions()
    }, PENDING_RESOLVE_RETRY_MS)
  }

  function stopPendingRetry(): void {
    if (!pendingRetryTimer) return
    clearTimeout(pendingRetryTimer)
    pendingRetryTimer = undefined
  }

  return {
    event: async ({ event }: HookInput): Promise<void> => {
      if (!config.enabled || !config.tmux_visualization) return

      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        streamTargetsBySession.delete(sessionID)
        pendingDeltaBuffer.clearSession(sessionID)
        clearSessionPartState(sessionID, partTextByKey)
        if (pendingDeltaBuffer.getPendingSessions().length === 0) stopPendingRetry()
        return
      }

      if (event.type === "message.part.removed") {
        const { sessionID, partID } = event.properties
        pendingDeltaBuffer.removePart(sessionID, partID)
        partTextByKey.delete(`${sessionID}:${partID}`)
        if (pendingDeltaBuffer.getPendingSessions().length === 0) stopPendingRetry()
        return
      }

      if (event.type === "session.error") {
        const sessionID = event.properties.sessionID
        if (sessionID) {
          streamTargetsBySession.delete(sessionID)
          pendingDeltaBuffer.clearSession(sessionID)
          clearSessionPartState(sessionID, partTextByKey)
        }
        if (pendingDeltaBuffer.getPendingSessions().length === 0) stopPendingRetry()
        return
      }

      if (event.type === "message.part.delta") {
        const pending = normalizeDeltaEventForBuffer(event)
        if (!pending) return
        const sessionID = event.properties.sessionID
        const target = await resolveStreamTarget(sessionID)
        if (!target) {
          pendingDeltaBuffer.enqueue(sessionID, pending)
          schedulePendingRetry()
          return
        }
        await flushPending(target, sessionID)
        const written = await writePendingEvent(target, sessionID, pending)
        if (!written) schedulePendingRetry()
        return
      }

      if (event.type !== "message.part.updated") return
      const pending = normalizeUpdateEventForBuffer(event)
      if (!pending) return
      const sessionID = event.properties.part.sessionID
      const target = await resolveStreamTarget(sessionID)
      if (!target) {
        pendingDeltaBuffer.enqueue(sessionID, pending)
        schedulePendingRetry()
        return
      }
      await flushPending(target, sessionID)
      const written = await writePendingEvent(target, sessionID, pending)
      if (!written) schedulePendingRetry()
    },
    dispose: () => {
      stopPendingRetry()
    },
  }
}
