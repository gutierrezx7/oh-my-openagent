import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { log } from "../../../shared/logger"
import type { BackgroundManager } from "../../background-agent/manager"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { canVisualize, removeTeamLayout } from "../team-layout-tmux/layout"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import { unregisterTeamSessionsByTeam } from "../team-session-registry"
import { loadRuntimeState, saveRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import type { RuntimeState } from "../types"
import { DELETABLE_MEMBER_STATUSES, removeWorktrees } from "./shutdown-helpers"

const DELETABLE_TEAM_STATUSES = new Set<RuntimeState["status"]>([
  "active",
  "shutdown_requested",
  "deleting",
  "deleted",
])

const FORCE_DELETABLE_TEAM_STATUSES = new Set<RuntimeState["status"]>([
  ...DELETABLE_TEAM_STATUSES,
  "creating",
  "orphaned",
])

const FORCE_COMPLETABLE_MEMBER_STATUSES = new Set<RuntimeState["members"][number]["status"]>([
  "pending",
  "running",
  "idle",
])

const FORCE_BYPASS_DELETING_STATUSES = new Set<RuntimeState["status"]>(["creating", "orphaned"])

export async function deleteTeam(
  teamRunId: string,
  config: TeamModeConfig,
  tmuxMgr?: TmuxSessionManager,
  bgMgr?: BackgroundManager,
  options?: { force?: boolean },
): Promise<{ removedWorktrees: string[]; removedLayout: boolean }> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  const nonLeadMembers = runtimeState.members.filter((member) => member.agentType !== "leader")

  if (bgMgr && runtimeState.leadSessionId) {
    const teamMessageMarkerPrefix = `team-create:${teamRunId}:`
    const teamTasks = bgMgr.getTasksByParentSession(runtimeState.leadSessionId)
      .filter((task) => task.parentMessageID?.startsWith(teamMessageMarkerPrefix))
    await Promise.all(teamTasks.map((task) => bgMgr.cancelTask(task.id, {
      source: "team-mode-delete",
      reason: `delete team ${teamRunId}`,
    })))
  }

  if (options?.force === true) {
    await transitionRuntimeState(teamRunId, (currentRuntimeState) => ({
      ...currentRuntimeState,
      members: currentRuntimeState.members.map((member) => (
        member.agentType === "leader" || !FORCE_COMPLETABLE_MEMBER_STATUSES.has(member.status)
          ? member
          : { ...member, status: "completed" }
      )),
    }), config)
  } else if (nonLeadMembers.some((member) => !DELETABLE_MEMBER_STATUSES.has(member.status))) {
    throw new Error("members still active")
  }

  const deletableTeamStatuses = options?.force === true
    ? FORCE_DELETABLE_TEAM_STATUSES
    : DELETABLE_TEAM_STATUSES
  if (!deletableTeamStatuses.has(runtimeState.status)) {
    throw new Error(`team cannot be deleted from '${runtimeState.status}'`)
  }

  if (runtimeState.status !== "deleting" && runtimeState.status !== "deleted") {
    if (options?.force === true && FORCE_BYPASS_DELETING_STATUSES.has(runtimeState.status)) {
      const currentRuntimeState = await loadRuntimeState(teamRunId, config)
      if (currentRuntimeState.status !== "deleting" && currentRuntimeState.status !== "deleted") {
        await saveRuntimeState({ ...currentRuntimeState, status: "deleting" }, config)
      }
    } else {
      await transitionRuntimeState(teamRunId, (currentRuntimeState) => (
        currentRuntimeState.status === "deleting"
          ? currentRuntimeState
          : { ...currentRuntimeState, status: "deleting" }
      ), config)
    }
  }

  const removedLayout = tmuxMgr !== undefined && canVisualize()
  if (removedLayout) {
    if (options?.force === true) {
      try {
        await removeTeamLayout(teamRunId, runtimeState.tmuxLayout, tmuxMgr)
      } catch (error) {
        log("team delete layout cleanup failed", {
          teamRunId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      await removeTeamLayout(teamRunId, runtimeState.tmuxLayout, tmuxMgr)
    }
  }

  const removedWorktrees = await removeWorktrees(runtimeState.members.map((member) => member.worktreePath))

  if (runtimeState.status !== "deleted") {
    await transitionRuntimeState(teamRunId, (currentRuntimeState) => (
      currentRuntimeState.status === "deleted"
        ? currentRuntimeState
        : { ...currentRuntimeState, status: "deleted" }
    ), config)
  }

  await removeWorktrees([getRuntimeStateDir(resolveBaseDir(config), teamRunId)])

  unregisterTeamSessionsByTeam(teamRunId)

  return { removedWorktrees, removedLayout }
}
