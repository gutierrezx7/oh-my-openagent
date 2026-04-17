import type { BackgroundManager } from "../../background-agent/manager"
import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { RuntimeState, Task } from "../types"
import { loadRuntimeState } from "../team-state-store/store"
import { listUnreadMessages } from "../team-mailbox/inbox"
import { listTasks } from "../team-tasklist/list"

export interface TeamStatus {
  teamName: string
  teamRunId: string
  status: RuntimeState["status"]
  leadSessionId?: string
  createdAt: number
  members: Array<{
    name: string
    sessionId?: string
    status: RuntimeState["members"][number]["status"]
    color?: string
    worktreePath?: string
    unreadMessages: number
    paneId?: string
  }>
  tasks: {
    pending: number
    claimed: number
    in_progress: number
    completed: number
    deleted: number
    total: number
  }
  shutdownRequests: RuntimeState["shutdownRequests"]
  concurrency: {
    runningOnSameModel: number
    queuedOnSameModel: number
    teamRunIdSpecific?: number
  }
  bounds: RuntimeState["bounds"]
}

type ConcurrencyCounts = {
  running: number
  queued: number
}

function isTaskStatus(status: string): status is Task["status"] {
  return status === "pending" || status === "claimed" || status === "in_progress" || status === "completed" || status === "deleted"
}

function countTasks(tasks: Task[]): TeamStatus["tasks"] {
  const counts = {
    pending: 0,
    claimed: 0,
    in_progress: 0,
    completed: 0,
    deleted: 0,
    total: 0,
  }

  for (const task of tasks) {
    if (!isTaskStatus(task.status)) continue

    counts[task.status] += 1
    counts.total += 1
  }

  return counts
}

function resolveConcurrencyCounts(bgMgr: BackgroundManager | undefined, teamRunId: string): ConcurrencyCounts {
  if (!bgMgr) return { running: 0, queued: 0 }

  const teamTasks = bgMgr.getTasksByParentSession(teamRunId)
  const running = teamTasks.filter((task) => task.status === "running").length
  const queued = teamTasks.filter((task) => task.status === "pending").length

  return { running, queued }
}

export async function aggregateStatus(
  teamRunId: string,
  config: TeamModeConfig,
  bgMgr?: BackgroundManager,
): Promise<TeamStatus> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  const unreadCounts = await Promise.all(
    runtimeState.members.map(async (member) => ({
      member,
      unreadMessages: (await listUnreadMessages(teamRunId, member.name, config)).length,
    })),
  )
  const tasks = await listTasks(teamRunId, config)
  const concurrencyCounts = resolveConcurrencyCounts(bgMgr, teamRunId)

  return {
    teamName: runtimeState.teamName,
    teamRunId: runtimeState.teamRunId,
    status: runtimeState.status,
    leadSessionId: runtimeState.leadSessionId,
    createdAt: runtimeState.createdAt,
    members: unreadCounts.map(({ member, unreadMessages }) => ({
      name: member.name,
      sessionId: member.sessionId,
      status: member.status,
      color: member.color,
      worktreePath: member.worktreePath,
      unreadMessages,
      paneId: member.tmuxPaneId,
    })),
    tasks: countTasks(tasks),
    shutdownRequests: runtimeState.shutdownRequests,
    concurrency: {
      runningOnSameModel: concurrencyCounts.running,
      queuedOnSameModel: concurrencyCounts.queued,
    },
    bounds: runtimeState.bounds,
  }
}
