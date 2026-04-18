import type { Event } from "@opencode-ai/sdk"

import type { TeamModeConfig } from "../../config/schema/team-mode"
import { getTeamMemberFifoPath } from "../../features/team-mode/team-layout-tmux/fifo-path"
import * as teamStateStore from "../../features/team-mode/team-state-store"
import { log } from "../../shared/logger"
import { clearSessionPartState, type PendingEventPreview, previewPendingEvent } from "./apply-pending-event"
import { runExclusiveDrain } from "./drain-loop"
import { type MessagePartDeltaEvent, normalizeDeltaEventForBuffer, normalizeUpdateEventForBuffer } from "./event-normalizer"
import { writeFifoSegment } from "./fifo-segment-writer"
import { createPendingDeltaBuffer, type PendingStreamEvent } from "./pending-delta-buffer"
import { createPendingRetryScheduler } from "./pending-retry-scheduler"
import { createStreamGeneration, type GenerationToken } from "./stream-generation"

type TeamStateStore = Pick<typeof teamStateStore, "listActiveTeams" | "loadRuntimeState">

type StreamEvent = Event | MessagePartDeltaEvent

type TeamSessionStreamTarget = {
  teamRunId: string
  memberName: string
  fifoPath: string
}

type HookInput = { event: StreamEvent }
type HookImpl = { event: (input: HookInput) => Promise<void>; dispose: () => void }

type AttemptWriteResult = { written: boolean; preview?: PendingEventPreview }

const PENDING_RESOLVE_RETRY_MS = 250

export function createTeamSessionStreamer(config: TeamModeConfig, stateStore: TeamStateStore): HookImpl {
  const streamTargetsBySession = new Map<string, TeamSessionStreamTarget>()
  const partTextByKey = new Map<string, string>()
  const pendingDeltaBuffer = createPendingDeltaBuffer()
  const generation = createStreamGeneration()
  const drainInFlight = new Set<string>()

  function hasPending(sessionID: string): boolean {
    return pendingDeltaBuffer.getPendingSessions().includes(sessionID)
  }

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
    const outcome = await writeFifoSegment(
      { teamRunId: target.teamRunId, memberName: target.memberName, sessionID, fifoPath: target.fifoPath },
      text,
    )
    if (outcome.clearCache) streamTargetsBySession.delete(sessionID)
    return outcome.written
  }

  async function attemptWrite(
    target: TeamSessionStreamTarget,
    sessionID: string,
    pending: PendingStreamEvent,
  ): Promise<AttemptWriteResult> {
    const preview = previewPendingEvent(pending, sessionID, partTextByKey)
    if (!preview) return { written: true }
    const written = await writeSegment(target, sessionID, preview.appendedText)
    return { written, preview: written ? preview : undefined }
  }

  async function drainAndWrite(target: TeamSessionStreamTarget, sessionID: string): Promise<boolean> {
    const drainSessionToken = generation.captureSession(sessionID)
    const drained = pendingDeltaBuffer.drain(sessionID)
    const drainPartTokens = new Map<string, GenerationToken>()
    for (const pending of drained) {
      drainPartTokens.set(pending.partID, generation.capturePart(sessionID, pending.partID))
    }
    for (let i = 0; i < drained.length; i++) {
      const pending = drained[i]
      const startPartToken = drainPartTokens.get(pending.partID)
      if (!startPartToken) continue
      if (!generation.isSessionCurrent(sessionID, drainSessionToken)) return false
      if (!generation.isPartCurrent(sessionID, pending.partID, startPartToken)) continue
      const result = await attemptWrite(target, sessionID, pending)
      if (!generation.isSessionCurrent(sessionID, drainSessionToken)) return false
      if (!generation.isPartCurrent(sessionID, pending.partID, startPartToken)) continue
      if (result.preview) partTextByKey.set(result.preview.partKey, result.preview.nextState)
      if (!result.written) {
        pendingDeltaBuffer.enqueue(sessionID, pending)
        for (let j = i + 1; j < drained.length; j++) {
          const remaining = drained[j]
          const remainingToken = drainPartTokens.get(remaining.partID)
          if (remainingToken && generation.isPartCurrent(sessionID, remaining.partID, remainingToken)) {
            pendingDeltaBuffer.enqueue(sessionID, remaining)
          }
        }
        return false
      }
    }
    return true
  }

  const retryScheduler = createPendingRetryScheduler({
    intervalMs: PENDING_RESOLVE_RETRY_MS,
    getPendingSessions: () => pendingDeltaBuffer.getPendingSessions(),
    drainSession: async (sessionID: string) => {
      const target = await resolveStreamTarget(sessionID)
      if (!target) return
      await runExclusiveDrain(
        sessionID,
        drainInFlight,
        () => drainAndWrite(target, sessionID),
        () => hasPending(sessionID),
      )
    },
  })

  async function handlePendingEvent(sessionID: string, pending: PendingStreamEvent): Promise<void> {
    const sessionTokenAtStart = generation.captureSession(sessionID)
    const partTokenAtStart = generation.capturePart(sessionID, pending.partID)
    pendingDeltaBuffer.enqueue(sessionID, pending)
    const target = await resolveStreamTarget(sessionID)
    if (!generation.isSessionCurrent(sessionID, sessionTokenAtStart)) return
    if (!generation.isPartCurrent(sessionID, pending.partID, partTokenAtStart)) return
    if (!target) {
      retryScheduler.schedule()
      return
    }
    const written = await runExclusiveDrain(
      sessionID,
      drainInFlight,
      () => drainAndWrite(target, sessionID),
      () => hasPending(sessionID),
    )
    if (!written) retryScheduler.schedule()
  }

  return {
    event: async ({ event }: HookInput): Promise<void> => {
      if (!config.enabled || !config.tmux_visualization) return

      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        generation.bumpSession(sessionID)
        streamTargetsBySession.delete(sessionID)
        pendingDeltaBuffer.clearSession(sessionID)
        clearSessionPartState(sessionID, partTextByKey)
        generation.clearSession(sessionID)
        if (pendingDeltaBuffer.getPendingSessions().length === 0) retryScheduler.stop()
        return
      }

      if (event.type === "message.part.removed") {
        const { sessionID, partID } = event.properties
        generation.bumpPart(sessionID, partID)
        pendingDeltaBuffer.removePart(sessionID, partID)
        partTextByKey.delete(`${sessionID}:${partID}`)
        generation.clearPart(sessionID, partID)
        if (pendingDeltaBuffer.getPendingSessions().length === 0) retryScheduler.stop()
        return
      }

      if (event.type === "session.error") {
        const sessionID = event.properties.sessionID
        if (sessionID) {
          generation.bumpSession(sessionID)
          streamTargetsBySession.delete(sessionID)
          pendingDeltaBuffer.clearSession(sessionID)
          clearSessionPartState(sessionID, partTextByKey)
          generation.clearSession(sessionID)
        }
        if (pendingDeltaBuffer.getPendingSessions().length === 0) retryScheduler.stop()
        return
      }

      if (event.type === "message.part.delta") {
        const pending = normalizeDeltaEventForBuffer(event)
        if (!pending) return
        await handlePendingEvent(event.properties.sessionID, pending)
        return
      }

      if (event.type !== "message.part.updated") return
      const pending = normalizeUpdateEventForBuffer(event)
      if (!pending) return
      await handlePendingEvent(event.properties.part.sessionID, pending)
    },
    dispose: () => {
      retryScheduler.dispose()
    },
  }
}
