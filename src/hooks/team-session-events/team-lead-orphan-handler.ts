import type { TeamModeConfig } from "../../config/schema/team-mode"
import { loadRuntimeState, listActiveTeams, transitionRuntimeState } from "../../features/team-mode/team-state-store/store"
import { log } from "../../shared/logger"

type HookInput = { event: { type: string; properties?: unknown } }
export type HookImpl = (input: HookInput) => Promise<void>

function getDeletedSessionID(properties: unknown): string | undefined {
  const record = properties as { info?: { id?: string } } | undefined
  return record?.info?.id
}

export function createTeamLeadOrphanHandler(config: TeamModeConfig): HookImpl {
  return async ({ event }: HookInput): Promise<void> => {
    if (event.type !== "session.deleted") return

    const deletedSessionID = getDeletedSessionID(event.properties)
    if (!deletedSessionID) return

    try {
      const activeTeams = await listActiveTeams(config)

      for (const activeTeam of activeTeams) {
        try {
          const runtimeState = await loadRuntimeState(activeTeam.teamRunId, config)
          if (runtimeState.leadSessionId !== deletedSessionID) continue

          const nextRuntimeState = await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
            ...currentRuntimeState,
            status: "orphaned",
          }), config)

          log("team lead session deleted", {
            event: "team-mode-lead-orphaned",
            teamRunId: runtimeState.teamRunId,
            teamName: runtimeState.teamName,
            deletedSessionID,
            previousStatus: runtimeState.status,
            nextStatus: nextRuntimeState.status,
          })
          return
        } catch (error) {
          log("team lead orphan handler skipped runtime", {
            event: "team-mode-lead-orphan-handler-runtime-error",
            teamRunId: activeTeam.teamRunId,
            deletedSessionID,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      log("team lead orphan handler failed", {
        event: "team-mode-lead-orphan-handler-error",
        deletedSessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
