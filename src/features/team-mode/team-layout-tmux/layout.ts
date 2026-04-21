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
}

export function canVisualize(): boolean { return process.env.TMUX !== undefined }

function getPaneWorkingDirectory(member: TeamLayoutMember): string {
  return member.worktreePath ?? process.cwd()
}

function buildAttachCommand(member: TeamLayoutMember, serverUrl: string): string {
  // Single positional passed directly to tmux's default shell. Tmux parses the line
  // into argv for opencode. Avoiding a sh -c wrapper keeps the TTY signal path
  // clean so attach-mode streams and Ctrl-C propagate without nested-shell lag.
  const parts = [
    "opencode",
    "attach",
    shellSingleQuote(serverUrl),
    "--session",
    shellSingleQuote(member.sessionId),
    "--dir",
    shellSingleQuote(getPaneWorkingDirectory(member)),
  ]
  return parts.join(" ")
}

async function createWindow(
  tmuxPath: string,
  targetSessionId: string,
  windowName: string,
  layout: "main-vertical" | "tiled",
  members: Array<TeamLayoutMember>,
  serverUrl: string,
): Promise<{ windowId: string; panesByMember: Record<string, string> } | null> {
  const [lead, ...rest] = members
  if (!lead) return null

  const created = await runTmuxCommand(tmuxPath, [
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_id} #{pane_id}",
    "-t",
    targetSessionId,
    "-n",
    windowName,
    "-c",
    getPaneWorkingDirectory(lead),
    buildAttachCommand(lead, serverUrl),
  ])
  if (!created.success || !created.output) return null
  const [windowId, leadPaneId] = created.output.split(" ", 2)
  if (!windowId || !leadPaneId) return null

  const panesByMember: Record<string, string> = {}

  panesByMember[lead.name] = leadPaneId
  for (const member of rest) {
    const split = await runTmuxCommand(tmuxPath, [
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      windowId,
      "-c",
      getPaneWorkingDirectory(member),
      buildAttachCommand(member, serverUrl),
    ])
    if (!split.success || !split.output) return null
    panesByMember[member.name] = split.output
  }

  if (!(await runTmuxCommand(tmuxPath, ["select-layout", "-t", windowId, layout])).success) return null

  for (const member of members) {
    const paneId = panesByMember[member.name]
    if (!paneId) return null
    if (!(await runTmuxCommand(tmuxPath, ["select-pane", "-t", paneId, "-T", member.name])).success) return null
    await runTmuxCommand(tmuxPath, ["set-option", "-t", paneId, "pane-border-status", "top"])
    await runTmuxCommand(tmuxPath, ["set-option", "-t", paneId, "pane-border-format", "#{pane_title}"])
  }

  return { windowId, panesByMember }
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
    const fallbackSessionName = `omo-team-${teamRunId}`
    const ownedSession = callerSession === null
    const targetSessionId = callerSession?.sessionId ?? fallbackSessionName

    if (ownedSession) {
      log("falling back to detached team session because caller tmux session could not be resolved", { teamRunId })
      const created = await runTmuxCommand(tmuxPath, ["new-session", "-d", "-s", fallbackSessionName, "-P", "-F", "#{window_id}"])
      if (!created.success || !created.output) return null
    }

    const teamRunSuffix = teamRunId.slice(0, 8)
    const focus = await createWindow(tmuxPath, targetSessionId, `focus-${teamRunSuffix}`, "main-vertical", members, serverUrl)
    const grid = await createWindow(tmuxPath, targetSessionId, `grid-${teamRunSuffix}`, "tiled", members, serverUrl)
    if (!focus || !grid) return null

    return {
      focusWindowId: focus.windowId,
      gridWindowId: grid.windowId,
      focusPanesByMember: focus.panesByMember,
      gridPanesByMember: grid.panesByMember,
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
