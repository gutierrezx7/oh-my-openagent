import { readdir } from "node:fs/promises"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"

export async function listUnreadMessages(
  teamRunId: string,
  memberName: string,
  config: TeamModeConfig,
): Promise<Array<{ id: string }>> {
  const baseDir = resolveBaseDir(config)
  const inboxDir = getInboxDir(baseDir, teamRunId, memberName)

  const entries = await readdir(inboxDir)
  return entries.map((id) => ({ id }))
}
