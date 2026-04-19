import { log } from "../../../shared"
import { shellEscapeForDoubleQuotedCommand } from "../../../shared/shell-env"
import { isServerRunning } from "../../../shared/tmux"
import { getTmuxPath } from "../../../tools/interactive-bash/tmux-path-resolver"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { runTmuxCommand } from "./tmux-runner"

type TeamLayoutMember = { name: string; sessionId: string; color?: string; worktreePath?: string }

type TeamLayoutResult = {
  focusWindowId: string
  gridWindowId: string
  panesByMember: Record<string, string>
}

export function canVisualize(): boolean { return process.env.TMUX !== undefined }

function getPaneWorkingDirectory(member: TeamLayoutMember): string {
  return member.worktreePath ?? process.cwd()
}

function buildAttachCommand(member: TeamLayoutMember, serverUrl: string): string {
  const shell = process.env.SHELL || "/bin/sh"
  const escapedUrl = shellEscapeForDoubleQuotedCommand(serverUrl)
  const escapedSessionId = shellEscapeForDoubleQuotedCommand(member.sessionId)
  const escapedDir = shellEscapeForDoubleQuotedCommand(getPaneWorkingDirectory(member))
  return `${shell} -c "opencode attach '${escapedUrl}' --session '${escapedSessionId}' --dir '${escapedDir}'"`
}

async function createWindow(
  tmuxPath: string,
  sessionName: string,
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
    sessionName,
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
  if (!canVisualize()) { log("tmux visualization unavailable, skipping"); return null }
  if (members.length === 0) return null
  try {
    const serverUrl = tmuxMgr.getServerUrl()
    if (!(await isServerRunning(serverUrl))) { log("opencode server not reachable, skipping team layout", { serverUrl }); return null }
    const tmuxPath = await getTmuxPath()
    if (!tmuxPath) { log("tmux visualization unavailable, skipping"); return null }
    const sessionName = `omo-team-${teamRunId}`
    const created = await runTmuxCommand(tmuxPath, ["new-session", "-d", "-s", sessionName, "-P", "-F", "#{window_id}"])
    if (!created.success || !created.output) return null
    const focus = await createWindow(tmuxPath, sessionName, "focus", "main-vertical", members, serverUrl)
    const grid = await createWindow(tmuxPath, sessionName, "grid", "tiled", members, serverUrl)
    if (!focus || !grid) return null
    return {
      focusWindowId: focus.windowId,
      gridWindowId: grid.windowId,
      panesByMember: focus.panesByMember,
    }
  } catch (error) {
    log("tmux visualization unavailable, skipping", { error: String(error) })
    return null
  }
}

export async function removeTeamLayout(teamRunId: string, _tmuxMgr: TmuxSessionManager): Promise<void> {
  if (!canVisualize()) return
  try {
    const tmuxPath = await getTmuxPath()
    if (!tmuxPath) return
    await runTmuxCommand(tmuxPath, ["kill-session", "-t", `omo-team-${teamRunId}`])
  } catch (error) {
    log("tmux team layout cleanup failed", { teamRunId, error: String(error) })
  }
}
