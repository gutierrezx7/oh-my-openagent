import type { TeamModeConfig } from "../../config/schema/team-mode"
import { loadRuntimeState, listActiveTeams, transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import { log } from "../../shared/logger"

type HookInput = { event: { type: string; properties?: unknown } }
export type HookImpl = (input: HookInput) => Promise<void>

function getErroredSessionID(properties: unknown): string | undefined {
  const record = properties as { sessionID?: string } | undefined
  return record?.sessionID
}

export function createTeamMemberErrorHandler(config: TeamModeConfig): HookImpl {
  return async ({ event }: HookInput): Promise<void> => {
    if (event.type !== "session.error") return

    const erroredSessionID = getErroredSessionID(event.properties)
    if (!erroredSessionID) return

    try {
      const activeTeams = await listActiveTeams(config)

      for (const activeTeam of activeTeams) {
        try {
          const runtimeState = await loadRuntimeState(activeTeam.teamRunId, config)
          const memberEntry = runtimeState.members.find((member) => member.sessionId === erroredSessionID)
          if (!memberEntry) continue

          await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
            ...currentRuntimeState,
            members: currentRuntimeState.members.map((member) => (
              member.name === memberEntry.name
                ? { ...member, status: "errored" }
                : member
            )),
          }), config)

          log("team member session errored", {
            event: "team-mode-member-errored",
            teamRunId: runtimeState.teamRunId,
            teamName: runtimeState.teamName,
            memberName: memberEntry.name,
            sessionID: erroredSessionID,
            runtimeStatus: runtimeState.status,
          })
          return
        } catch (error) {
          log("team member error handler skipped runtime", {
            event: "team-mode-member-error-handler-runtime-error",
            teamRunId: activeTeam.teamRunId,
            sessionID: erroredSessionID,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      log("team member error handler failed", {
        event: "team-mode-member-error-handler-error",
        sessionID: erroredSessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
