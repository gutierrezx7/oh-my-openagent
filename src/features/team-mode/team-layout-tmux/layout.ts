import { log } from "../../../shared"
import { shellSingleQuote } from "../../../shared/shell-env"
import { isServerRunning, runTmuxCommand } from "../../../shared/tmux"
import { getTmuxPath } from "../../../tools/interactive-bash/tmux-path-resolver"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { resolveCallerTmuxSession } from "./resolve-caller-tmux-session"

type TeamLayoutMember = { name: string; sessionId: string; worktreePath?: string }

export type TeamLayoutResult = {
  focusWindowId: string
  gridWindowId: string
  focusPanesByMember: Record<string, string>
  gridPanesByMember: Record<string, string>
  targetSessionId: string
  ownedSession: boolean
}

export type TeamLayoutCleanupTarget = {
  ownedSession: boolean
  targetSessionId: string
  focusWindowId?: string
  gridWindowId?: string
  paneIds?: Array<string>
}

export function canVisualize(): boolean { return process.env.TMUX !== undefined }

function getPaneWorkingDirectory(member: TeamLayoutMember): string {
  return member.worktreePath ?? process.cwd()
}

const SHELL_READY_POLL_MS = 100
const SHELL_READY_MAX_ATTEMPTS = 30

async function waitForPaneShellReady(tmuxPath: string, paneIds: Array<string>): Promise<void> {
  for (let attempt = 0; attempt < SHELL_READY_MAX_ATTEMPTS; attempt++) {
    const results = await Promise.all(paneIds.map((paneId) =>
      runTmuxCommand(tmuxPath, ["display", "-p", "-t", paneId, "#{pane_current_command}"])))
    if (results.every((r) => r.success)) return
    await new Promise((resolve) => setTimeout(resolve, SHELL_READY_POLL_MS))
  }
}

function buildAttachCommand(member: TeamLayoutMember, serverUrl: string): string {
  return `opencode attach ${serverUrl} --session ${member.sessionId} --dir ${shellSingleQuote(getPaneWorkingDirectory(member))}`
}

async function resolveCurrentWindowId(tmuxPath: string): Promise<string | null> {
  const callerPane = process.env.TMUX_PANE
  if (!callerPane) return null
  const result = await runTmuxCommand(tmuxPath, ["display", "-p", "-t", callerPane, "#{window_id}"])
  if (!result.success || !result.output) return null
  return result.output.trim()
}

export async function createTeamLayout(teamRunId: string, members: Array<TeamLayoutMember>, tmuxMgr: TmuxSessionManager): Promise<TeamLayoutResult | null> {
  if (!canVisualize()) {
    log("tmux visualization unavailable, skipping")
    return null
  }
  if (members.length === 0) return null

  try {
    const serverUrl = tmuxMgr.getServerUrl()
    if (!(await isServerRunning(serverUrl))) {
      log("opencode server not reachable, skipping team layout", { serverUrl })
      return null
    }

    const tmuxPath = await getTmuxPath()
    if (!tmuxPath) {
      log("tmux visualization unavailable, skipping")
      return null
    }

    const callerSession = await resolveCallerTmuxSession(tmuxPath)
    const callerPane = process.env.TMUX_PANE
    const currentWindowId = await resolveCurrentWindowId(tmuxPath)
    const fallbackSessionName = `omo-team-${teamRunId}`
    const ownedSession = callerSession === null
    const targetSessionId = callerSession?.sessionId ?? fallbackSessionName

    if (ownedSession) {
      log("falling back to detached team session because caller tmux session could not be resolved", { teamRunId })
      const created = await runTmuxCommand(tmuxPath, ["new-session", "-d", "-s", fallbackSessionName, "-P", "-F", "#{window_id}"])
      if (!created.success || !created.output) return null
    }

    const panesByMember: Record<string, string> = {}
    const splitTarget = callerPane ?? targetSessionId

    for (const member of members) {
      const split = await runTmuxCommand(tmuxPath, [
        "split-window",
        "-d",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        splitTarget,
        "-c",
        getPaneWorkingDirectory(member),
      ])
      if (!split.success || !split.output) continue
      panesByMember[member.name] = split.output.trim()
    }

    if (Object.keys(panesByMember).length === 0) return null

    const windowId = currentWindowId ?? targetSessionId
    await runTmuxCommand(tmuxPath, ["select-layout", "-t", windowId, "tiled"])

    for (const [name, paneId] of Object.entries(panesByMember)) {
      await runTmuxCommand(tmuxPath, ["select-pane", "-t", paneId, "-T", name])
      await runTmuxCommand(tmuxPath, ["set-option", "-p", "-t", paneId, "pane-border-status", "top"])
      await runTmuxCommand(tmuxPath, ["set-option", "-p", "-t", paneId, "pane-border-format", "#{pane_title}"])
    }

    await waitForPaneShellReady(tmuxPath, Object.values(panesByMember))

    for (const [, paneId] of Object.entries(panesByMember)) {
      const member = members.find((m) => panesByMember[m.name] === paneId)
      if (!member) continue
      const cmd = buildAttachCommand(member, serverUrl)
      await runTmuxCommand(tmuxPath, ["send-keys", "-t", paneId, "-l", cmd])
      await runTmuxCommand(tmuxPath, ["send-keys", "-t", paneId, "Enter"])
    }

    return {
      focusWindowId: windowId,
      gridWindowId: windowId,
      focusPanesByMember: panesByMember,
      gridPanesByMember: panesByMember,
      targetSessionId,
      ownedSession,
    }
  } catch (error) {
    log("tmux visualization unavailable, skipping", { error: String(error) })
    return null
  }
}

export async function removeTeamLayout(teamRunId: string, _tmuxMgr: TmuxSessionManager): Promise<void>
export async function removeTeamLayout(
  teamRunId: string,
  _cleanupTarget: TeamLayoutCleanupTarget | undefined,
  _tmuxMgr: TmuxSessionManager,
): Promise<void>
export async function removeTeamLayout(
  teamRunId: string,
  tmuxMgrOrCleanupTarget: TmuxSessionManager | TeamLayoutCleanupTarget | undefined,
  _tmuxMgr?: TmuxSessionManager,
): Promise<void> {
  if (!canVisualize()) return
  try {
    const tmuxPath = await getTmuxPath()
    if (!tmuxPath) return

    const cleanupTarget = isTeamLayoutCleanupTarget(tmuxMgrOrCleanupTarget)
      ? tmuxMgrOrCleanupTarget
      : undefined

    if (cleanupTarget?.ownedSession !== false) {
      await runTmuxCommand(tmuxPath, [
        "kill-session",
        "-t",
        cleanupTarget?.targetSessionId ?? `omo-team-${teamRunId}`,
      ])
      return
    }

    if (cleanupTarget.paneIds && cleanupTarget.paneIds.length > 0) {
      for (const paneId of cleanupTarget.paneIds) {
        try {
          await runTmuxCommand(tmuxPath, ["kill-pane", "-t", paneId])
        } catch {
          log("tmux team pane cleanup failed", { teamRunId, paneId })
        }
      }
      return
    }

    for (const windowId of [cleanupTarget.focusWindowId, cleanupTarget.gridWindowId]) {
      if (!windowId) continue
      try {
        await runTmuxCommand(tmuxPath, ["kill-window", "-t", windowId])
      } catch (windowError) {
        log("tmux team layout window cleanup failed", {
          teamRunId,
          windowId,
          error: String(windowError),
        })
      }
    }
  } catch (error) {
    log("tmux team layout cleanup failed", { teamRunId, error: String(error) })
  }
}

function isTeamLayoutCleanupTarget(value: TmuxSessionManager | TeamLayoutCleanupTarget | undefined): value is TeamLayoutCleanupTarget {
  return value !== undefined && "ownedSession" in value && "targetSessionId" in value
}
