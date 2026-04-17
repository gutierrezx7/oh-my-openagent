import type { Event, EventMessagePartUpdated, Part } from "@opencode-ai/sdk"

import type { TeamModeConfig } from "../../config/schema/team-mode"
import { getTeamMemberFifoPath } from "../../features/team-mode/team-layout-tmux/fifo-path"
import * as teamStateStore from "../../features/team-mode/team-state-store"
import { log } from "../../shared/logger"
import { writeTeamSessionFifo } from "./fifo-writer"

type TeamStateStore = Pick<typeof teamStateStore, "listActiveTeams" | "loadRuntimeState">

type MessagePartDeltaEvent = {
  type: "message.part.delta"
  properties: {
    sessionID: string
    partID?: string
    field?: string
    delta: string
  }
}

type StreamEvent = Event | MessagePartDeltaEvent

type TeamSessionStreamTarget = {
  teamRunId: string
  memberName: string
  fifoPath: string
}

type HookInput = { event: StreamEvent }
type HookImpl = { event: (input: HookInput) => Promise<void> }

const DROPPABLE_FIFO_ERROR_CODES = new Set(["ENXIO", "ENOENT", "EPIPE"])

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

function extractCumulativeText(part: Part): string | undefined {
  if ("text" in part && typeof part.text === "string") return part.text
  return undefined
}

function extractUpdateSegment(
  event: EventMessagePartUpdated,
  partTextByKey: Map<string, string>,
): { sessionID: string; text: string } | undefined {
  const part = event.properties.part
  const delta = event.properties.delta
  const partKey = `${part.sessionID}:${part.id}`

  if (typeof delta === "string" && delta.length > 0) {
    const previousText = partTextByKey.get(partKey) ?? ""
    partTextByKey.set(partKey, previousText + delta)
    return { sessionID: part.sessionID, text: delta }
  }

  const cumulativeText = extractCumulativeText(part)
  if (cumulativeText === undefined) return undefined

  const previousText = partTextByKey.get(partKey) ?? ""
  partTextByKey.set(partKey, cumulativeText)

  const appendedText = cumulativeText.startsWith(previousText)
    ? cumulativeText.slice(previousText.length)
    : cumulativeText
  if (appendedText.length === 0) return undefined
  return { sessionID: part.sessionID, text: appendedText }
}

function extractDeltaSegment(
  event: MessagePartDeltaEvent,
  partTextByKey: Map<string, string>,
): { sessionID: string; text: string } | undefined {
  const { sessionID, partID, field, delta } = event.properties
  if (typeof delta !== "string" || delta.length === 0) return undefined
  if (field !== undefined && field !== "text" && field !== "content") return undefined

  if (partID) {
    const partKey = `${sessionID}:${partID}`
    const previousText = partTextByKey.get(partKey) ?? ""
    partTextByKey.set(partKey, previousText + delta)
  }

  return { sessionID, text: delta }
}

function clearSessionPartState(sessionID: string, partTextByKey: Map<string, string>): void {
  for (const partKey of partTextByKey.keys()) {
    if (partKey.startsWith(`${sessionID}:`)) {
      partTextByKey.delete(partKey)
    }
  }
}

export function createTeamSessionStreamer(config: TeamModeConfig, stateStore: TeamStateStore): HookImpl {
  const streamTargetsBySession = new Map<string, TeamSessionStreamTarget>()
  const partTextByKey = new Map<string, string>()

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

  async function writeSegment(
    sessionID: string,
    text: string,
  ): Promise<void> {
    const target = await resolveStreamTarget(sessionID)
    if (!target) return

    try {
      await writeTeamSessionFifo(target.fifoPath, text)
    } catch (error) {
      if (isErrorWithCode(error) && DROPPABLE_FIFO_ERROR_CODES.has(error.code)) {
        if (error.code === "ENOENT") {
          streamTargetsBySession.delete(sessionID)
        }
        return
      }

      log("team session streamer write failed", {
        event: "team-mode-session-streamer-write-error",
        teamRunId: target.teamRunId,
        memberName: target.memberName,
        sessionID,
        fifoPath: target.fifoPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    event: async ({ event }: HookInput): Promise<void> => {
      if (!config.enabled || !config.tmux_visualization) return

      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id
        streamTargetsBySession.delete(sessionID)
        clearSessionPartState(sessionID, partTextByKey)
        return
      }

      if (event.type === "message.part.removed") {
        partTextByKey.delete(`${event.properties.sessionID}:${event.properties.partID}`)
        return
      }

      if (event.type === "session.error") {
        const sessionID = event.properties.sessionID
        if (sessionID) {
          streamTargetsBySession.delete(sessionID)
          clearSessionPartState(sessionID, partTextByKey)
        }
        return
      }

      if (event.type === "message.part.delta") {
        const segment = extractDeltaSegment(event, partTextByKey)
        if (!segment) return
        await writeSegment(segment.sessionID, segment.text)
        return
      }

      if (event.type !== "message.part.updated") return
      const segment = extractUpdateSegment(event, partTextByKey)
      if (!segment) return

      await writeSegment(segment.sessionID, segment.text)
    },
  }
}
