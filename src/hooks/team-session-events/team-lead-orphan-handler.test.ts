/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import {
  clearTeamSessionRegistry,
  registerTeamSession,
} from "../../features/team-mode/team-session-registry"
import type { RuntimeState } from "../../features/team-mode/types"
import { loadRuntimeState, saveRuntimeState } from "../../features/team-mode/team-state-store/store"
import { createTeamLeadOrphanHandler } from "./team-lead-orphan-handler"

const temporaryDirectories: string[] = []

async function createTemporaryBaseDir(): Promise<string> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "team-lead-orphan-handler-"))
  temporaryDirectories.push(baseDir)
  return baseDir
}

function createConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({ base_dir: baseDir, enabled: true })
}

function createRuntimeState(teamRunId: string): RuntimeState {
  return {
    version: 1,
    teamRunId,
    teamName: "team-alpha",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: "lead-session",
    members: [
      {
        name: "worker",
        sessionId: "member-session",
        agentType: "general-purpose",
        status: "running",
        pendingInjectedMessageIds: [],
      },
    ],
    shutdownRequests: [],
    bounds: {
      maxMembers: 8,
      maxParallelMembers: 4,
      maxMessagesPerRun: 10000,
      maxWallClockMinutes: 120,
      maxMemberTurns: 500,
    },
  }
}

async function seedRuntimeState(runtimeState: RuntimeState, config: TeamModeConfig): Promise<void> {
  await mkdir(path.join(config.base_dir ?? "", "runtime", runtimeState.teamRunId), { recursive: true })
  await saveRuntimeState(runtimeState, config)
}

afterEach(async () => {
  clearTeamSessionRegistry()
  await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
    await rm(directoryPath, { recursive: true, force: true })
  }))
})

describe("createTeamLeadOrphanHandler", () => {
  test("orphanes the team when the deleted session matches the lead", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    await seedRuntimeState(createRuntimeState(teamRunId), config)
    const handler = createTeamLeadOrphanHandler(config)

    // when
    await handler({
      event: {
        type: "session.deleted",
        properties: { info: { id: "lead-session" } },
      },
    })

    // then
    const runtimeState = await loadRuntimeState(teamRunId, config)
    expect(runtimeState.status).toBe("orphaned")
  })

  test("orphanes the team during the spawn race when the registry tracks the fresh lead session before disk state persists it", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    await seedRuntimeState({
      ...createRuntimeState(teamRunId),
      leadSessionId: undefined,
    }, config)
    registerTeamSession("lead-session", {
      teamRunId,
      memberName: "lead",
      role: "lead",
    })
    const handler = createTeamLeadOrphanHandler(config)

    // when
    await handler({
      event: {
        type: "session.deleted",
        properties: { info: { id: "lead-session" } },
      },
    })

    // then
    const runtimeState = await loadRuntimeState(teamRunId, config)
    expect(runtimeState.status).toBe("orphaned")
  })

  test("falls back to disk lookup when the registry points the lead session at the wrong teamRunId", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const correctTeamRunId = randomUUID()
    const wrongTeamRunId = randomUUID()
    await seedRuntimeState(createRuntimeState(correctTeamRunId), config)
    await seedRuntimeState({
      ...createRuntimeState(wrongTeamRunId),
      leadSessionId: "other-lead-session",
    }, config)
    registerTeamSession("lead-session", {
      teamRunId: wrongTeamRunId,
      memberName: "lead",
      role: "lead",
    })
    const handler = createTeamLeadOrphanHandler(config)

    // when
    await handler({
      event: {
        type: "session.deleted",
        properties: { info: { id: "lead-session" } },
      },
    })

    // then
    const correctRuntimeState = await loadRuntimeState(correctTeamRunId, config)
    const wrongRuntimeState = await loadRuntimeState(wrongTeamRunId, config)
    expect(correctRuntimeState.status).toBe("orphaned")
    expect(wrongRuntimeState.status).toBe("active")
  })
})
