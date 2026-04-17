import type { TeamModeConfig } from "../../config/schema/team-mode"
import { getTeamMemberFifoPath } from "../../features/team-mode/team-layout-tmux/fifo-path"
import * as teamStateStore from "../../features/team-mode/team-state-store"
import { log } from "../../shared/logger"
import { writeTeamSessionFifo } from "./fifo-writer"

type TeamStateStore = Pick<typeof teamStateStore, "listActiveTeams" | "loadRuntimeState">

type TeamSessionStreamTarget = {
  teamRunId: string
  memberName: string
  fifoPath: string
}

type TeamSessionStreamEvent = {
  type: string
  properties?: unknown
}

type HookInput = {
  event?: unknown
}

type HookImpl = {
  event: (input: HookInput) => Promise<void>
}

const DROPPABLE_FIFO_ERROR_CODES = new Set(["ENXIO", "ENOENT", "EPIPE"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

function normalizeEvent(input: HookInput): TeamSessionStreamEvent | undefined {
  if (!isRecord(input.event) || typeof input.event.type !== "string") return undefined
  return {
    type: input.event.type,
    properties: input.event.properties,
  }
}

function getDeletedSessionID(properties: unknown): string | undefined {
  if (!isRecord(properties) || !isRecord(properties.info)) return undefined
  return typeof properties.info.id === "string" ? properties.info.id : undefined
}

function getRemovedPartRef(properties: unknown): { sessionID: string; partID: string } | undefined {
  if (!isRecord(properties)) return undefined
  return typeof properties.sessionID === "string" && typeof properties.partID === "string"
    ? { sessionID: properties.sessionID, partID: properties.partID }
    : undefined
}

function getErroredSessionID(properties: unknown): string | undefined {
  return isRecord(properties) && typeof properties.sessionID === "string" ? properties.sessionID : undefined
}

function getTextPart(properties: unknown): { sessionID: string; partID: string; text: string } | undefined {
  if (!isRecord(properties) || !isRecord(properties.part)) {
    return undefined
  }

  const part = properties.part
  const sessionID = typeof properties.sessionID === "string"
    ? properties.sessionID
    : typeof part.sessionID === "string"
      ? part.sessionID
      : undefined

  if (!sessionID) return undefined
  if (typeof part.id !== "string") return undefined
  if (typeof part.text === "string") {
    return { sessionID, partID: part.id, text: part.text }
  }
  if (typeof part.content === "string") {
    return { sessionID, partID: part.id, text: part.content }
  }
}

function getUpdatedSegment(
  properties: unknown,
  partTextByKey: Map<string, string>,
): { sessionID: string; text: string } | undefined {
  if (!isRecord(properties)) return undefined

  const delta = typeof properties.delta === "string" ? properties.delta : undefined
  const part = getTextPart(properties)
  if (!part) return undefined
  const partKey = `${part.sessionID}:${part.partID}`

  if (delta && delta.length > 0) {
    const previousText = partTextByKey.get(partKey) ?? ""
    partTextByKey.set(partKey, previousText + delta)
    return { sessionID: part.sessionID, text: delta }
  }

  const previousText = partTextByKey.get(partKey) ?? ""
  partTextByKey.set(partKey, part.text)
  const appendedText = part.text.startsWith(previousText)
    ? part.text.slice(previousText.length)
    : part.text

  if (appendedText.length === 0) return undefined
  return { sessionID: part.sessionID, text: appendedText }
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

  return {
    event: async (input: HookInput): Promise<void> => {
      const event = normalizeEvent(input)
      if (!event) return
      if (!config.enabled || !config.tmux_visualization) return

      if (event.type === "session.deleted") {
        const sessionID = getDeletedSessionID(event.properties)
        if (!sessionID) return
        streamTargetsBySession.delete(sessionID)
        clearSessionPartState(sessionID, partTextByKey)
        return
      }

      if (event.type === "message.part.removed") {
        const removedPart = getRemovedPartRef(event.properties)
        if (!removedPart) return
        partTextByKey.delete(`${removedPart.sessionID}:${removedPart.partID}`)
        return
      }

      if (event.type === "session.error") {
        const sessionID = getErroredSessionID(event.properties)
        if (!sessionID) return
        streamTargetsBySession.delete(sessionID)
        clearSessionPartState(sessionID, partTextByKey)
        return
      }

      if (event.type !== "message.part.updated") return
      const segment = getUpdatedSegment(event.properties, partTextByKey)
      if (!segment) return

      const target = await resolveStreamTarget(segment.sessionID)
      if (!target) return

      try {
        await writeTeamSessionFifo(target.fifoPath, segment.text)
      } catch (error) {
        if (isErrorWithCode(error) && DROPPABLE_FIFO_ERROR_CODES.has(error.code)) {
          if (error.code === "ENOENT") {
            streamTargetsBySession.delete(segment.sessionID)
          }
          return
        }

        log("team session streamer write failed", {
          event: "team-mode-session-streamer-write-error",
          teamRunId: target.teamRunId,
          memberName: target.memberName,
          sessionID: segment.sessionID,
          fifoPath: target.fifoPath,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}
