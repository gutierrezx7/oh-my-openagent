/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import type { ExecutorContext } from "../../tools/delegate-task/executor-types"
import { BackgroundManager } from "../background-agent/manager"
import type { BackgroundTask, LaunchInput } from "../background-agent/types"
import { getRuntimeStateDir, resolveBaseDir } from "./team-registry/paths"
import type { TeamSpec } from "./types"

const resolveMemberMock = mock(async (member: TeamSpec["members"][number]) => ({
  agentToUse: `${member.name}-agent`,
  model: { providerID: "openai", modelID: "gpt-5.4-mini" },
  fallbackChain: undefined,
  systemContent: `system:${member.name}`,
}))

mock.module("./team-runtime/resolve-member", () => ({ resolveMember: resolveMemberMock }))
mock.module("./team-layout-tmux/layout", () => ({
  canVisualize: () => false,
  createTeamLayout: mock(async () => undefined),
  removeTeamLayout: mock(async () => undefined),
}))

const { sendMessage } = await import("./team-mailbox/send")
const { createTeamRun } = await import("./team-runtime/create")
const { deleteTeam } = await import("./team-runtime/shutdown")
const { aggregateStatus } = await import("./team-runtime/status")
const { createTask, claimTask, listTasks, updateTaskStatus } = await import("./team-tasklist")
const { resumeAllTeams } = await import("./team-state-store/resume")
const { loadRuntimeState, saveRuntimeState } = await import("./team-state-store/store")

const temporaryDirectories: string[] = []
type MockClient = ExecutorContext["client"] & { session: { get: ReturnType<typeof mock> } }

function createConfig(baseDir: string, overrides: Partial<TeamModeConfig> = {}): TeamModeConfig {
  return TeamModeConfigSchema.parse({ enabled: true, base_dir: baseDir, max_wall_clock_minutes: 1, ...overrides })
}

function createSpec(name: string, leadAgentId: string, members: TeamSpec["members"]): TeamSpec {
  return { version: 1, name, createdAt: Date.now(), leadAgentId, members }
}

function createClient(aliveSessionIds: ReadonlySet<string>): MockClient {
  return {
    session: {
      get: mock(async ({ path: { id } }: { path: { id: string } }) => aliveSessionIds.has(id)
        ? { data: { id } }
        : { error: Object.assign(new Error("session not found"), { status: 404 }) }),
    },
  } as MockClient
}

function createManager(launchImpl?: (input: LaunchInput) => Promise<BackgroundTask>) {
  const manager = Object.create(BackgroundManager.prototype) as BackgroundManager
  let launchCount = 0
  manager.launch = mock((input: LaunchInput) => launchImpl?.(input) ?? Promise.resolve({
    id: `task-${++launchCount}`,
    sessionID: `ses_mock_${randomUUID()}`,
    status: "running",
  } as BackgroundTask))
  manager.getTask = mock(() => undefined)
  manager.cancelTask = mock(async () => true)
  manager.getTasksByParentSession = mock(() => [])
  return manager
}

function createContext(directory: string, manager: BackgroundManager, aliveSessionIds: ReadonlySet<string>): ExecutorContext {
  return { client: createClient(aliveSessionIds), manager, directory }
}

async function createBaseDir(): Promise<string> {
  const directory = path.join(tmpdir(), `team-mode-int-${randomUUID()}`)
  temporaryDirectories.push(directory)
  await mkdir(directory, { recursive: true })
  return directory
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

afterEach(async () => {
  resolveMemberMock.mockClear()
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })))
})

describe("team-mode integration", () => {
  test("C-10.1 creates a single-member echo team, delivers mail, surfaces unread status, and deletes runtime", async () => {
    // given
    const baseDir = await createBaseDir()
    const config = createConfig(baseDir)
    const manager = createManager()
    const runtime = await createTeamRun(createSpec("echo-team", "echo", [{ kind: "subagent_type", name: "echo", subagent_type: "atlas", backendType: "in-process", isActive: true }]), "ses_lead", createContext(baseDir, manager, new Set(["ses_lead"])), config, manager)

    // when
    const delivered = await sendMessage({ version: 1, messageId: randomUUID(), from: "echo", to: "echo", kind: "message", body: "hello", timestamp: Date.now() }, runtime.teamRunId, config, { isLead: true, activeMembers: ["echo"] })
    const status = await aggregateStatus(runtime.teamRunId, config)
    await deleteTeam(runtime.teamRunId, config, undefined, manager)

    // then
    expect(runtime.status).toBe("active")
    expect(runtime.members).toHaveLength(1)
    expect(runtime.members[0]?.sessionId).toMatch(/^ses_mock_/) 
    expect(delivered.deliveredTo).toEqual(["echo"])
    expect(status.members[0]?.unreadMessages).toBe(1)
    expect(await exists(getRuntimeStateDir(resolveBaseDir(config), runtime.teamRunId))).toBe(false)
  })

  test("C-10.2 runs a 2-member pipeline where worker claims and completes a lead-created task", async () => {
    // given
    const baseDir = await createBaseDir()
    const config = createConfig(baseDir)
    const manager = createManager()
    const runtime = await createTeamRun(createSpec("pipeline-team", "lead", [
      { kind: "subagent_type", name: "lead", subagent_type: "sisyphus", backendType: "in-process", isActive: true },
      { kind: "subagent_type", name: "worker", subagent_type: "atlas", backendType: "in-process", isActive: true },
    ]), "ses_lead", createContext(baseDir, manager, new Set(["ses_lead"])), config, manager)
    const createdTask = await createTask(runtime.teamRunId, { subject: "X", description: "Ship X", blocks: [], blockedBy: [], status: "pending" }, config)

    // when
    const claimedTask = await claimTask(runtime.teamRunId, createdTask.id, "worker", config)
    await updateTaskStatus(runtime.teamRunId, createdTask.id, "in_progress", "worker", config)
    await updateTaskStatus(runtime.teamRunId, createdTask.id, "completed", "worker", config)
    const completedTasks = await listTasks(runtime.teamRunId, config, { status: "completed" })

    // then
    expect(claimedTask.status).toBe("claimed")
    expect(claimedTask.owner).toBe("worker")
    expect(completedTasks).toHaveLength(1)
    expect(completedTasks[0]?.subject).toBe("X")
  })

  test("C-10.3 resumes alive teams, orphans dead leads, fails stuck creating teams, and cleans deleting runs", async () => {
    // given
    const baseDir = await createBaseDir()
    const aliveSessionIds = new Set(["ses_alive"])
    const config = createConfig(baseDir)
    const manager = createManager()
    const context = createContext(baseDir, manager, aliveSessionIds)
    const aliveRuntime = await createTeamRun(createSpec("alive-team", "lead", [{ kind: "subagent_type", name: "lead", subagent_type: "sisyphus", backendType: "in-process", isActive: true }]), "ses_alive", context, config, manager)
    const deadRuntime = await createTeamRun(createSpec("dead-team", "lead", [{ kind: "subagent_type", name: "lead", subagent_type: "atlas", backendType: "in-process", isActive: true }]), "ses_dead", context, config, manager)
    const stuckRuntime = await createTeamRun(createSpec("stuck-team", "lead", [{ kind: "subagent_type", name: "lead", subagent_type: "atlas", backendType: "in-process", isActive: true }]), "ses_stuck", context, config, manager)
    const deletingRuntime = await createTeamRun(createSpec("deleting-team", "lead", [{ kind: "subagent_type", name: "lead", subagent_type: "atlas", backendType: "in-process", isActive: true }]), "ses_delete", context, config, manager)
    await saveRuntimeState({ ...(await loadRuntimeState(stuckRuntime.teamRunId, config)), status: "creating", createdAt: Date.now() - 40 * 60 * 1000 }, config)
    await saveRuntimeState({ ...(await loadRuntimeState(deletingRuntime.teamRunId, config)), status: "deleting" }, config)

    // when
    const report = await resumeAllTeams(context, config)

    // then
    expect(report).toEqual({ resumed: 1, marked_failed: 1, marked_orphaned: 1, cleaned: 1, errors: [] })
    expect((await loadRuntimeState(aliveRuntime.teamRunId, config)).status).toBe("active")
    expect((await loadRuntimeState(deadRuntime.teamRunId, config)).status).toBe("orphaned")
    expect((await loadRuntimeState(stuckRuntime.teamRunId, config)).status).toBe("failed")
    expect(await exists(getRuntimeStateDir(resolveBaseDir(config), deletingRuntime.teamRunId))).toBe(false)
  })

  test("C-10.4 keeps member spawn concurrency within max_parallel_members", async () => {
    // given
    const baseDir = await createBaseDir()
    let inFlight = 0
    let maxInFlight = 0
    const manager = createManager(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 10))
      inFlight -= 1
      return { id: `task-${randomUUID()}`, sessionID: `ses_mock_${randomUUID()}`, status: "running" } as BackgroundTask
    })

    // when
    await createTeamRun(createSpec("parallel-team", "lead", [
      { kind: "subagent_type", name: "lead", subagent_type: "sisyphus", backendType: "in-process", isActive: true },
      { kind: "subagent_type", name: "worker-a", subagent_type: "atlas", backendType: "in-process", isActive: true },
      { kind: "subagent_type", name: "worker-b", subagent_type: "atlas", backendType: "in-process", isActive: true },
    ]), "ses_lead", createContext(baseDir, manager, new Set(["ses_lead"])), createConfig(baseDir, { max_parallel_members: 2 }), manager)

    // then
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })
})
