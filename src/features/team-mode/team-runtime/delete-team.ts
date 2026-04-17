import { rm } from "node:fs/promises"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { BackgroundManager } from "../../background-agent/manager"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { canVisualize, removeTeamLayout } from "../team-layout-tmux/layout"
import { getTeamFifoDirectory } from "../team-layout-tmux/fifo-path"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import type { RuntimeState } from "../types"
import { DELETABLE_MEMBER_STATUSES, removeWorktrees } from "./shutdown-helpers"

const DELETABLE_TEAM_STATUSES = new Set<RuntimeState["status"]>([
  "active",
  "shutdown_requested",
  "deleting",
  "deleted",
])

export async function deleteTeam(
  teamRunId: string,
  config: TeamModeConfig,
  tmuxMgr?: TmuxSessionManager,
  bgMgr?: BackgroundManager,
): Promise<{ removedWorktrees: string[]; removedLayout: boolean }> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  const nonLeadMembers = runtimeState.members.filter((member) => member.agentType !== "leader")
  if (nonLeadMembers.some((member) => !DELETABLE_MEMBER_STATUSES.has(member.status))) {
    throw new Error("members still active")
  }

  if (!DELETABLE_TEAM_STATUSES.has(runtimeState.status)) {
    throw new Error(`team cannot be deleted from '${runtimeState.status}'`)
  }

  if (runtimeState.status !== "deleting" && runtimeState.status !== "deleted") {
    await transitionRuntimeState(teamRunId, (currentRuntimeState) => (
      currentRuntimeState.status === "deleting"
        ? currentRuntimeState
        : { ...currentRuntimeState, status: "deleting" }
    ), config)
  }

  if (bgMgr && runtimeState.leadSessionId) {
    const teamTasks = bgMgr.getTasksByParentSession(runtimeState.leadSessionId)
    await Promise.all(teamTasks.map((task) => bgMgr.cancelTask(task.id, {
      source: "team-mode-delete",
      reason: `delete team ${teamRunId}`,
    })))
  }

  const removedLayout = tmuxMgr !== undefined && canVisualize()
  if (removedLayout) {
    await removeTeamLayout(teamRunId, tmuxMgr)
  }

  await rm(getTeamFifoDirectory(teamRunId), { recursive: true, force: true })
  const removedWorktrees = await removeWorktrees(nonLeadMembers.map((member) => member.worktreePath))

  if (runtimeState.status !== "deleted") {
    await transitionRuntimeState(teamRunId, (currentRuntimeState) => (
      currentRuntimeState.status === "deleted"
        ? currentRuntimeState
        : { ...currentRuntimeState, status: "deleted" }
    ), config)
  }

  await removeWorktrees([getRuntimeStateDir(resolveBaseDir(config), teamRunId)])

  return { removedWorktrees, removedLayout }
}
