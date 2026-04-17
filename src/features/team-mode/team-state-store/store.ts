import { mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import { atomicWrite, withLock } from "./locks"
import { RuntimeStateSchema } from "../types"
import type { RuntimeState } from "../types"

export class RuntimeStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "RuntimeStateError"
  }
}

function getRuntimeStatePath(teamRunId: string, config: TeamModeConfig): string {
  const baseDir = resolveBaseDir(config)
  return path.join(getRuntimeStateDir(baseDir, teamRunId), "state.json")
}

async function readRuntimeStateFile(teamRunId: string, config: TeamModeConfig): Promise<RuntimeState> {
  const statePath = getRuntimeStatePath(teamRunId, config)

  try {
    const content = await readFile(statePath, "utf8")
    return RuntimeStateSchema.parse(JSON.parse(content))
  } catch (error) {
    throw new RuntimeStateError(`failed to load runtime state for ${teamRunId}`, { cause: error })
  }
}

export async function loadRuntimeState(
  teamRunId: string,
  config: TeamModeConfig,
): Promise<RuntimeState> {
  return await readRuntimeStateFile(teamRunId, config)
}

export async function saveRuntimeState(
  runtimeState: RuntimeState,
  config: TeamModeConfig,
): Promise<void> {
  const statePath = getRuntimeStatePath(runtimeState.teamRunId, config)
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
  await atomicWrite(statePath, `${JSON.stringify(runtimeState, null, 2)}\n`)
}

export async function transitionRuntimeState(
  teamRunId: string,
  transition: (runtimeState: RuntimeState) => RuntimeState,
  config: TeamModeConfig,
): Promise<RuntimeState> {
  const runtimeStateDir = path.dirname(getRuntimeStatePath(teamRunId, config))
  await mkdir(runtimeStateDir, { recursive: true, mode: 0o700 })

  return await withLock(path.join(runtimeStateDir, "state.lock"), async () => {
    const currentState = await readRuntimeStateFile(teamRunId, config)
    const nextState = RuntimeStateSchema.parse(transition(currentState))
    await saveRuntimeState(nextState, config)
    return nextState
  }, { ownerTag: `runtime-state:${teamRunId}` })
}

export async function listActiveTeams(
  config: TeamModeConfig,
): Promise<Array<{ teamRunId: string; teamName: string; status: RuntimeState["status"] }>> {
  const runtimeRoot = path.join(resolveBaseDir(config), "runtime")

  try {
    const directoryEntries = await readdir(runtimeRoot, { withFileTypes: true })
    const states = await Promise.all(directoryEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const runtimeState = await loadRuntimeState(entry.name, config)
          return {
            teamRunId: runtimeState.teamRunId,
            teamName: runtimeState.teamName,
            status: runtimeState.status,
          }
        } catch {
          return null
        }
      }))

    return states.filter((state): state is NonNullable<typeof state> => state !== null)
  } catch {
    return []
  }
}
