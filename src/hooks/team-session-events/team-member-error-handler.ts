import type { TeamModeConfig } from "../../config/schema/team-mode"
import { lookupTeamSession } from "../../features/team-mode/team-session-registry"
import { loadRuntimeState, listActiveTeams, transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import { log } from "../../shared/logger"

type HookInput = { event: { type: string; properties?: unknown } }
export type HookImpl = (input: HookInput) => Promise<void>

function getErroredSessionID(properties: unknown): string | undefined {
  const record = properties as { sessionID?: string } | undefined
  return record?.sessionID
}

type ResolvedRuntimeMember = {
  teamRunId: string
  memberName: string
}

async function findRuntimeMember(
  erroredSessionID: string,
  config: TeamModeConfig,
): Promise<ResolvedRuntimeMember | null> {
  const registryEntry = lookupTeamSession(erroredSessionID)
  if (registryEntry?.role === "member") {
    try {
      const runtimeState = await loadRuntimeState(registryEntry.teamRunId, config)
      const memberEntry = runtimeState.members.find(
        (member) => member.name === registryEntry.memberName
          && (member.sessionId === undefined || member.sessionId === erroredSessionID),
      )

      if (memberEntry !== undefined) {
        return {
          teamRunId: runtimeState.teamRunId,
          memberName: memberEntry.name,
        }
      }
    } catch (error) {
      log("team member error handler registry lookup failed", {
        event: "team-mode-member-error-handler-registry-error",
        teamRunId: registryEntry.teamRunId,
        sessionID: erroredSessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const activeTeams = await listActiveTeams(config)

  for (const activeTeam of activeTeams) {
    try {
      const runtimeState = await loadRuntimeState(activeTeam.teamRunId, config)
      const memberEntry = runtimeState.members.find(
        (member) => member.sessionId === erroredSessionID,
      )
      if (memberEntry !== undefined) {
        return {
          teamRunId: runtimeState.teamRunId,
          memberName: memberEntry.name,
        }
      }
    } catch (error) {
      log("team member error handler skipped runtime", {
        event: "team-mode-member-error-handler-runtime-error",
        teamRunId: activeTeam.teamRunId,
        sessionID: erroredSessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return null
}

export function createTeamMemberErrorHandler(config: TeamModeConfig): HookImpl {
  return async ({ event }: HookInput): Promise<void> => {
    if (event.type !== "session.error") return

    const erroredSessionID = getErroredSessionID(event.properties)
    if (!erroredSessionID) return

    try {
      const runtimeMember = await findRuntimeMember(erroredSessionID, config)
      if (runtimeMember === null) {
        return
      }

      const runtimeState = await loadRuntimeState(runtimeMember.teamRunId, config)
      await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
        ...currentRuntimeState,
        members: currentRuntimeState.members.map((member) => (
          member.name === runtimeMember.memberName
            ? { ...member, status: "errored" }
            : member
        )),
      }), config)

      log("team member session errored", {
        event: "team-mode-member-errored",
        teamRunId: runtimeState.teamRunId,
        teamName: runtimeState.teamName,
        memberName: runtimeMember.memberName,
        sessionID: erroredSessionID,
        runtimeStatus: runtimeState.status,
      })
    } catch (error) {
      log("team member error handler failed", {
        event: "team-mode-member-error-handler-error",
        sessionID: erroredSessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
