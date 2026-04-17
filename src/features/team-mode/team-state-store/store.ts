import { readFile } from "node:fs/promises"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { RuntimeState } from "../types"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"

export async function loadRuntimeState(teamRunId: string, config: TeamModeConfig): Promise<RuntimeState> {
  const baseDir = resolveBaseDir(config)
  const statePath = `${getRuntimeStateDir(baseDir, teamRunId)}/state.json`

  const content = await readFile(statePath, "utf8")
  return JSON.parse(content) as RuntimeState
}
