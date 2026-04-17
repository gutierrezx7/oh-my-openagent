import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { BackgroundManager } from "../../background-agent/manager"
import type { RuntimeState } from "../types"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { sendMessage } from "../team-mailbox/send"
import { removeTeamLayout, canVisualize } from "../team-layout-tmux/layout"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import {
  createSendContext,
  createShutdownMessage,
  DELETABLE_MEMBER_STATUSES,
  findLatestShutdownRequestIndex,
  getLeadMemberName,
  getRuntimeMember,
  removeWorktrees,
} from "./shutdown-helpers"

const DELETABLE_TEAM_STATUSES = new Set<RuntimeState["status"]>([
  "active",
  "shutdown_requested",
  "deleting",
  "deleted",
])

export async function requestShutdownOfMember(
  teamRunId: string,
  targetMemberName: string,
  requesterName: string,
  config: TeamModeConfig,
): Promise<void> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  getRuntimeMember(runtimeState, targetMemberName)
  getRuntimeMember(runtimeState, requesterName)

  const existingRequestIndex = findLatestShutdownRequestIndex(runtimeState, targetMemberName, requesterName)
  if (existingRequestIndex >= 0) {
    const existingRequest = runtimeState.shutdownRequests[existingRequestIndex]
    if (existingRequest?.approvedAt === undefined && existingRequest?.rejectedAt === undefined) {
      return
    }
  }

  await sendMessage(
    createShutdownMessage(requesterName, targetMemberName, "shutdown_request", ""),
    teamRunId,
    config,
    createSendContext(runtimeState, requesterName),
  )

  await transitionRuntimeState(teamRunId, (currentRuntimeState) => {
    const duplicateRequestIndex = findLatestShutdownRequestIndex(currentRuntimeState, targetMemberName, requesterName)
    if (duplicateRequestIndex >= 0) {
      const duplicateRequest = currentRuntimeState.shutdownRequests[duplicateRequestIndex]
      if (duplicateRequest?.approvedAt === undefined && duplicateRequest?.rejectedAt === undefined) {
        return currentRuntimeState
      }
    }

    return {
      ...currentRuntimeState,
      shutdownRequests: [
        ...currentRuntimeState.shutdownRequests,
        { memberId: targetMemberName, requesterName, requestedAt: Date.now() },
      ],
    }
  }, config)
}

export async function approveShutdown(
  teamRunId: string,
  memberName: string,
  approverName: string,
  config: TeamModeConfig,
): Promise<void> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  getRuntimeMember(runtimeState, approverName)
  const shutdownRequestIndex = findLatestShutdownRequestIndex(runtimeState, memberName)
  if (shutdownRequestIndex < 0) {
    throw new Error(`shutdown request missing for '${memberName}'`)
  }

  const existingRequest = runtimeState.shutdownRequests[shutdownRequestIndex]
  if (existingRequest?.approvedAt !== undefined) {
    return
  }

  const updatedRuntimeState = await transitionRuntimeState(teamRunId, (currentRuntimeState) => {
    const currentRequestIndex = findLatestShutdownRequestIndex(currentRuntimeState, memberName)
    if (currentRequestIndex < 0) {
      throw new Error(`shutdown request missing for '${memberName}'`)
    }

    const currentRequest = currentRuntimeState.shutdownRequests[currentRequestIndex]
    if (!currentRequest || currentRequest.approvedAt !== undefined) {
      return currentRuntimeState
    }

    return {
      ...currentRuntimeState,
      members: currentRuntimeState.members.map((member) => {
        if (member.name !== memberName || member.status === "completed" || member.status === "errored") {
          return member
        }

        return { ...member, status: "shutdown_approved" }
      }),
      shutdownRequests: currentRuntimeState.shutdownRequests.map((shutdownRequest, index) => index === currentRequestIndex
        ? { ...shutdownRequest, approvedAt: Date.now() }
        : shutdownRequest),
    }
  }, config)

  await sendMessage(
    createShutdownMessage(approverName, getLeadMemberName(updatedRuntimeState), "shutdown_approved", memberName),
    teamRunId,
    config,
    createSendContext(updatedRuntimeState, approverName),
  )
}

export async function rejectShutdown(
  teamRunId: string,
  memberName: string,
  reason: string,
  config: TeamModeConfig,
): Promise<void> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  const shutdownRequestIndex = findLatestShutdownRequestIndex(runtimeState, memberName)
  if (shutdownRequestIndex < 0) {
    throw new Error(`shutdown request missing for '${memberName}'`)
  }

  const shutdownRequest = runtimeState.shutdownRequests[shutdownRequestIndex]
  if (shutdownRequest.rejectedAt !== undefined && shutdownRequest.rejectedReason === reason) {
    return
  }

  await sendMessage(
    createShutdownMessage(memberName, shutdownRequest.requesterName, "shutdown_rejected", reason),
    teamRunId,
    config,
    createSendContext(runtimeState, memberName),
  )

  await transitionRuntimeState(teamRunId, (currentRuntimeState) => {
    const currentRequestIndex = findLatestShutdownRequestIndex(currentRuntimeState, memberName)
    if (currentRequestIndex < 0) {
      throw new Error(`shutdown request missing for '${memberName}'`)
    }

    return {
      ...currentRuntimeState,
      shutdownRequests: currentRuntimeState.shutdownRequests.map((currentRequest, index) => index === currentRequestIndex
        ? { ...currentRequest, rejectedAt: Date.now(), rejectedReason: reason }
        : currentRequest),
    }
  }, config)
}

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

  if (bgMgr) {
    const teamTasks = bgMgr.getTasksByParentSession(teamRunId)
    await Promise.all(teamTasks.map((task) => bgMgr.cancelTask(task.id, {
      source: "team-mode-delete",
      reason: `delete team ${teamRunId}`,
    })))
  }

  const removedLayout = tmuxMgr !== undefined && canVisualize()
  if (removedLayout) {
    await removeTeamLayout(teamRunId, tmuxMgr)
  }

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
