/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { TeamSpec } from "../types"
import { resumeAllTeams } from "./resume"
import { createRuntimeState, loadRuntimeState, saveRuntimeState, transitionRuntimeState } from "./store"

async function createTemporaryBaseDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "team-mode-resume-"))
}

function createConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({
    base_dir: baseDir,
    max_members: 6,
    max_parallel_members: 3,
    max_messages_per_run: 200,
    max_wall_clock_minutes: 45,
    max_member_turns: 50,
  })
}

function createSpec(name = `team-${randomUUID().slice(0, 8)}`): TeamSpec {
  return {
    version: 1,
    name,
    createdAt: Date.now(),
    leadAgentId: "lead",
    members: [
      {
        kind: "subagent_type",
        name: "lead",
        subagent_type: "sisyphus",
        backendType: "in-process",
        isActive: true,
        color: "red",
      },
      {
        kind: "category",
        name: "worker",
        category: "deep",
        prompt: "implement task",
        backendType: "in-process",
        isActive: true,
        color: "blue",
      },
    ],
  }
}

type SessionGetMock = (input: { path: { id: string } }) => Promise<unknown>

function createExecutorContext(
  directory: string,
  sessionGet: SessionGetMock = mock(async () => ({ data: null })),
): ExecutorContext {
  return {
    client: {
      session: {
        get: sessionGet,
      },
    } as ExecutorContext["client"],
    manager: {} as ExecutorContext["manager"],
    directory,
  }
}

describe("resumeAllTeams", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }))
    mock.restore()
  })

  test("marks stuck creating teams failed after reload recovery", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec(), "ses_lead", "user", config)
    const worktreePath = path.join(baseDir, "worktrees", runtimeState.teamRunId, "worker")
    await mkdir(worktreePath, { recursive: true })
    await saveRuntimeState({
      ...runtimeState,
      createdAt: Date.now() - 40 * 60 * 1000,
      members: runtimeState.members.map((member) => member.name === "worker"
        ? { ...member, worktreePath }
        : member),
    }, config)

    // when
    const report = await resumeAllTeams(createExecutorContext(baseDir), config)
    const persistedState = await loadRuntimeState(runtimeState.teamRunId, config)

    // then
    expect(persistedState.status).toBe("failed")
    expect(report).toEqual({
      resumed: 0,
      marked_failed: 1,
      marked_orphaned: 0,
      cleaned: 0,
      errors: [],
    })
    let statError: NodeJS.ErrnoException | null = null
    try {
      await stat(worktreePath)
    } catch (error) {
      statError = error as NodeJS.ErrnoException
    }
    expect(statError?.code).toBe("ENOENT")
  })

  test("marks active teams orphaned when lead session no longer exists", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec(), "ses_dead", "project", config)
    await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
      ...currentRuntimeState,
      status: "active",
    }), config)
    const sessionGet = mock(async () => {
      throw Object.assign(new Error("session not found"), { status: 404 })
    })

    // when
    const report = await resumeAllTeams(createExecutorContext(baseDir, sessionGet), config)
    const persistedState = await loadRuntimeState(runtimeState.teamRunId, config)

    // then
    expect(sessionGet).toHaveBeenCalledTimes(1)
    expect(persistedState.status).toBe("orphaned")
    expect(report).toEqual({
      resumed: 0,
      marked_failed: 0,
      marked_orphaned: 1,
      cleaned: 0,
      errors: [],
    })
  })

  test("preserves active teams when lead session is still alive", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    temporaryDirectories.push(baseDir)
    const config = createConfig(baseDir)
    const runtimeState = await createRuntimeState(createSpec(), "ses_alive", "user", config)
    await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
      ...currentRuntimeState,
      status: "active",
    }), config)
    const sessionGet = mock(async () => ({ data: { id: "ses_alive" } }))

    // when
    const report = await resumeAllTeams(createExecutorContext(baseDir, sessionGet), config)
    const persistedState = await loadRuntimeState(runtimeState.teamRunId, config)

    // then
    expect(sessionGet).toHaveBeenCalledTimes(1)
    expect(persistedState.status).toBe("active")
    expect(report).toEqual({
      resumed: 1,
      marked_failed: 0,
      marked_orphaned: 0,
      cleaned: 0,
      errors: [],
    })
  })
})
