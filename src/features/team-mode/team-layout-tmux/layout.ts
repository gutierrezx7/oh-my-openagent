import { log } from "../../../shared"
import { getTmuxPath } from "../../../tools/interactive-bash/tmux-path-resolver"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { runTmuxCommand } from "./tmux-runner"

type TeamLayoutMember = { name: string; sessionId: string; color?: string }

type TeamLayoutResult = {
  focusWindowId: string
  gridWindowId: string
  panesByMember: Record<string, string>
}

export function canVisualize(): boolean { return process.env.TMUX !== undefined }

async function createWindow(
  tmuxPath: string,
  sessionName: string,
  windowName: string,
  layout: "main-vertical" | "tiled",
  members: Array<TeamLayoutMember>,
): Promise<{ windowId: string; panesByMember: Record<string, string> } | null> {
  const created = await runTmuxCommand(tmuxPath, ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionName, "-n", windowName])
  if (!created.success || !created.output) return null
  const panesByMember: Record<string, string> = {}
  const [lead, ...rest] = members
  if (!lead) return null

  panesByMember[lead.name] = created.output
  for (const member of rest) {
    const split = await runTmuxCommand(tmuxPath, ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", panesByMember[lead.name] ?? created.output, "sh", "-c", "cat >/dev/null"])
    if (!split.success || !split.output) return null
    panesByMember[member.name] = split.output
  }

  if (!(await runTmuxCommand(tmuxPath, ["select-layout", "-t", `${sessionName}:${created.output}`, layout])).success) return null

  for (const member of members) {
    const paneId = panesByMember[member.name]
    if (!paneId) return null
    const label = member.color ? `${member.name} ${member.color}` : member.name
    if (!(await runTmuxCommand(tmuxPath, ["select-pane", "-t", paneId, "-T", label])).success) return null
    await runTmuxCommand(tmuxPath, ["set-option", "-t", paneId, "pane-border-status", "top"])
    await runTmuxCommand(tmuxPath, ["set-option", "-t", paneId, "pane-border-format", `#{pane_title} ${label}`])
    await runTmuxCommand(tmuxPath, ["pipe-pane", "-I", "-t", paneId, "cat >/dev/null"])
  }

  return { windowId: created.output, panesByMember }
}

export async function createTeamLayout(teamRunId: string, members: Array<TeamLayoutMember>, tmuxMgr: TmuxSessionManager): Promise<TeamLayoutResult | null> {
  void tmuxMgr
  if (!canVisualize()) { log("tmux visualization unavailable, skipping"); return null }
  try {
    const tmuxPath = await getTmuxPath()
    if (!tmuxPath) { log("tmux visualization unavailable, skipping"); return null }
    const sessionName = `omo-team-${teamRunId}`
    const created = await runTmuxCommand(tmuxPath, ["new-session", "-d", "-s", sessionName, "-P", "-F", "#{window_id}"])
    if (!created.success || !created.output) return null
    const focus = await createWindow(tmuxPath, sessionName, "focus", "main-vertical", members)
    const grid = await createWindow(tmuxPath, sessionName, "grid", "tiled", members)
    if (!focus || !grid) return null
    return { focusWindowId: focus.windowId, gridWindowId: grid.windowId, panesByMember: focus.panesByMember }
  } catch (error) {
    log("tmux visualization unavailable, skipping", { error: String(error) })
    return null
  }
}

export async function removeTeamLayout(teamRunId: string, tmuxMgr: TmuxSessionManager): Promise<void> {
  void tmuxMgr
  if (!canVisualize()) return
  try {
    const tmuxPath = await getTmuxPath()
    if (!tmuxPath) return
    await runTmuxCommand(tmuxPath, ["kill-session", "-t", `omo-team-${teamRunId}`])
  } catch {
    return
  }
}
