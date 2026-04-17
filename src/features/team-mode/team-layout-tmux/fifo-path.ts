import path from "node:path"

const TEAM_TMUX_FIFO_ROOT = "/tmp/omo-team"

export function getTeamFifoDirectory(teamRunId: string): string {
  return path.join(TEAM_TMUX_FIFO_ROOT, teamRunId)
}

export function getTeamMemberFifoPath(teamRunId: string, memberName: string): string {
  return path.join(getTeamFifoDirectory(teamRunId), `${memberName}.fifo`)
}
