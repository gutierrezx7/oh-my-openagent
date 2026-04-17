import { log } from "../../../shared"
import { getTmuxPath } from "../../../tools/interactive-bash/tmux-path-resolver"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { ensureTeamMemberFifo } from "./ensure-team-member-fifo"
import { runTmuxCommand } from "./tmux-runner"

type TeamLayoutMember = { name: string; sessionId: string; color?: string; worktreePath?: string }

type TeamLayoutResult = {
  focusWindowId: string
  gridWindowId: string
  panesByMember: Record<string, string>
  fifoByMember: Record<string, string>
}

export function canVisualize(): boolean { return process.env.TMUX !== undefined }

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function getPaneWorkingDirectory(member: TeamLayoutMember): string {
  return member.worktreePath ?? process.cwd()
}

async function createWindow(
  tmuxPath: string,
  sessionName: string,
  windowName: string,
  layout: "main-vertical" | "tiled",
  members: Array<TeamLayoutMember>,
  fifoByMember: Record<string, string>,
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
    ])
    if (!split.success || !split.output) return null
    panesByMember[member.name] = split.output
  }

  if (!(await runTmuxCommand(tmuxPath, ["select-layout", "-t", windowId, layout])).success) return null

  for (const member of members) {
    const paneId = panesByMember[member.name]
    const fifoPath = fifoByMember[member.name]
    if (!paneId) return null
    if (!fifoPath) return null
    if (!(await runTmuxCommand(tmuxPath, ["select-pane", "-t", paneId, "-T", member.name])).success) return null
    await runTmuxCommand(tmuxPath, ["set-option", "-t", paneId, "pane-border-status", "top"])
    await runTmuxCommand(tmuxPath, ["set-option", "-t", paneId, "pane-border-format", "#{pane_title}"])
    await runTmuxCommand(tmuxPath, ["send-keys", "-t", paneId, `tail -n +1 -f ${quoteShellArgument(fifoPath)}`, "Enter"])
  }

  return { windowId, panesByMember }
}

export async function createTeamLayout(teamRunId: string, members: Array<TeamLayoutMember>, _tmuxMgr: TmuxSessionManager): Promise<TeamLayoutResult | null> {
  if (!canVisualize()) { log("tmux visualization unavailable, skipping"); return null }
  try {
    const tmuxPath = await getTmuxPath()
    if (!tmuxPath) { log("tmux visualization unavailable, skipping"); return null }
    const fifoByMember = Object.fromEntries(await Promise.all(members.map(async (member) => {
      const fifoPath = await ensureTeamMemberFifo(teamRunId, member.name)
      return [member.name, fifoPath]
    })))
    const sessionName = `omo-team-${teamRunId}`
    const created = await runTmuxCommand(tmuxPath, ["new-session", "-d", "-s", sessionName, "-P", "-F", "#{window_id}"])
    if (!created.success || !created.output) return null
    const focus = await createWindow(tmuxPath, sessionName, "focus", "main-vertical", members, fifoByMember)
    const grid = await createWindow(tmuxPath, sessionName, "grid", "tiled", members, fifoByMember)
    if (!focus || !grid) return null
    return {
      focusWindowId: focus.windowId,
      gridWindowId: grid.windowId,
      panesByMember: focus.panesByMember,
      fifoByMember,
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
  } catch {
    return
  }
}
