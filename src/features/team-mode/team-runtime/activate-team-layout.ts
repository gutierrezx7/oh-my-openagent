import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { createTeamLayout } from "../team-layout-tmux/layout"
import type { RuntimeState } from "../types"
import { transitionRuntimeState } from "../team-state-store/store"

export async function activateTeamLayout(
  runtimeState: RuntimeState,
  config: TeamModeConfig,
  projectRoot: string,
  tmuxMgr?: TmuxSessionManager,
): Promise<boolean> {
  if (!config.tmux_visualization || !tmuxMgr) return false

  const layout = await createTeamLayout(
    runtimeState.teamRunId,
    runtimeState.members.flatMap((member) => member.sessionId
      ? [{
          name: member.name,
          sessionId: member.sessionId,
          color: member.color,
          worktreePath: member.worktreePath ?? projectRoot,
        }]
      : []),
    tmuxMgr,
  )
  if (!layout) return false

  await transitionRuntimeState(runtimeState.teamRunId, (currentState) => ({
    ...currentState,
    members: currentState.members.map((member) => ({
      ...member,
      tmuxPaneId: layout.panesByMember[member.name] ?? member.tmuxPaneId,
    })),
  }), config)
  return true
}
