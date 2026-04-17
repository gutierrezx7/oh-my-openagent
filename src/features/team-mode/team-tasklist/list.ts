import { readdir, readFile } from "node:fs/promises"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { Task } from "../types"
import { getTasksDir, resolveBaseDir } from "../team-registry/paths"

export async function listTasks(teamRunId: string, config: TeamModeConfig): Promise<Task[]> {
  const baseDir = resolveBaseDir(config)
  const tasksDir = getTasksDir(baseDir, teamRunId)
  const entries = await readdir(tasksDir)
  const tasks = await Promise.all(entries.map(async (entry) => JSON.parse(await readFile(`${tasksDir}/${entry}`, "utf8")) as Task))
  return tasks
}
