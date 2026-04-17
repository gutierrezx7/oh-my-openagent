import { describe, expect, mock, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

let loadRuntimeStateImplementation: typeof import("../team-state-store/store").loadRuntimeState = async () => {
  throw new Error("loadRuntimeStateImplementation not set")
}

let listUnreadMessagesImplementation: typeof import("../team-mailbox/inbox").listUnreadMessages = async () => {
  throw new Error("listUnreadMessagesImplementation not set")
}

let listTasksImplementation: typeof import("../team-tasklist/list").listTasks = async () => {
  throw new Error("listTasksImplementation not set")
}

mock.module("../team-state-store/store", () => ({
  loadRuntimeState: (...args: Parameters<typeof loadRuntimeStateImplementation>) => loadRuntimeStateImplementation(...args),
}))

mock.module("../team-mailbox/inbox", () => ({
  listUnreadMessages: (...args: Parameters<typeof listUnreadMessagesImplementation>) => listUnreadMessagesImplementation(...args),
}))

mock.module("../team-tasklist/list", () => ({
  listTasks: (...args: Parameters<typeof listTasksImplementation>) => listTasksImplementation(...args),
}))

import type { BackgroundManager } from "../../background-agent/manager"
import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { aggregateStatus } from "./status"
import { loadRuntimeState } from "../team-state-store/store"
import { listUnreadMessages } from "../team-mailbox/inbox"
import { listTasks } from "../team-tasklist/list"

void loadRuntimeState
void listUnreadMessages
void listTasks

describe("aggregateStatus", () => {
  test("surfaces stale locks from claims directory", async () => {
    // given
    const baseDir = "/tmp/team-mode-status-stale-lock"
    const claimsDir = path.join(baseDir, "runtime", "team-run-3", "tasks", "claims")
    await rm(baseDir, { force: true, recursive: true })
    await mkdir(claimsDir, { recursive: true })
    await writeFile(path.join(claimsDir, "task-claimed.lock"), "owner\n999999\n1\n")
    const config = { base_dir: baseDir } satisfies TeamModeConfig
    loadRuntimeStateImplementation = async () => ({
      version: 1,
      teamRunId: "team-run-3",
      teamName: "team-gamma",
      specSource: "project",
      createdAt: 123,
      status: "active",
      leadSessionId: "lead-3",
      members: [],
      shutdownRequests: [],
      bounds: { maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 10000, maxWallClockMinutes: 120, maxMemberTurns: 500 },
    })
    listUnreadMessagesImplementation = async () => []
    listTasksImplementation = async () => [
      { version: 1, id: "task-claimed", subject: "a", description: "a", status: "claimed", createdAt: 1, updatedAt: 1, blocks: [], blockedBy: [] },
    ]

    // when
    const result = await aggregateStatus("team-run-3", config)

    // then
    expect(result.staleLocks).toEqual([path.join(claimsDir, "task-claimed.lock")])
  })

  test("aggregates members plus tasks plus unread counts", async () => {
    // given
    const config = { base_dir: "/tmp/team-mode" } satisfies TeamModeConfig
    loadRuntimeStateImplementation = async () => ({
      version: 1,
      teamRunId: "team-run-1",
      teamName: "team-alpha",
      specSource: "project",
      createdAt: 123,
      status: "active",
      leadSessionId: "lead-1",
      members: [
        { name: "member-a", agentType: "general-purpose", status: "running", color: "red", worktreePath: "/work/a", sessionId: "session-a", tmuxPaneId: "1", lastInjectedTurnMarker: undefined, pendingInjectedMessageIds: [] },
        { name: "member-b", agentType: "general-purpose", status: "idle", color: "blue", worktreePath: "/work/b", sessionId: "session-b", tmuxPaneId: "2", lastInjectedTurnMarker: undefined, pendingInjectedMessageIds: [] },
      ],
      shutdownRequests: [],
      bounds: { maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 10000, maxWallClockMinutes: 120, maxMemberTurns: 500 },
    })
    listUnreadMessagesImplementation = async (_teamRunId, memberName) => memberName === "member-a" ? [{ id: "1" }, { id: "2" }] : []
    listTasksImplementation = async () => [
      { version: 1, id: "task-1", subject: "a", description: "a", status: "pending", createdAt: 1, updatedAt: 1, blocks: [], blockedBy: [] },
      { version: 1, id: "task-2", subject: "b", description: "b", status: "pending", createdAt: 1, updatedAt: 1, blocks: [], blockedBy: [] },
      { version: 1, id: "task-3", subject: "c", description: "c", status: "pending", createdAt: 1, updatedAt: 1, blocks: [], blockedBy: [] },
      { version: 1, id: "task-4", subject: "d", description: "d", status: "completed", createdAt: 1, updatedAt: 1, blocks: [], blockedBy: [] },
    ]

    // when
    const result = await aggregateStatus("team-run-1", config)

    // then
    expect(result.teamName).toBe("team-alpha")
    expect(result.members).toEqual([
      expect.objectContaining({ name: "member-a", unreadMessages: 2 }),
      expect.objectContaining({ name: "member-b", unreadMessages: 0 }),
    ])
    expect(result.tasks).toEqual({ pending: 3, claimed: 0, in_progress: 0, completed: 1, deleted: 0, total: 4 })
  })

  test("surfaces queued and running counts on same model", async () => {
    // given
    const config = { base_dir: "/tmp/team-mode" } satisfies TeamModeConfig
    loadRuntimeStateImplementation = async () => ({
      version: 1,
      teamRunId: "team-run-2",
      teamName: "team-beta",
      specSource: "project",
      createdAt: 123,
      status: "active",
      leadSessionId: "lead-2",
      members: [],
      shutdownRequests: [],
      bounds: { maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 10000, maxWallClockMinutes: 120, maxMemberTurns: 500 },
    })
    listUnreadMessagesImplementation = async () => []
    listTasksImplementation = async () => []
    const backgroundManager = {
      getTasksByParentSession: () => [
        { status: "running", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
        { status: "running", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
        { status: "running", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
        { status: "running", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
        { status: "running", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
        { status: "pending", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
        { status: "pending", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
        { status: "pending", model: { providerID: "anthropic", modelID: "claude-opus-4-7" } },
      ],
      getConcurrencyCounts: () => ({ running: 5, queued: 3 }),
      listTasksByParentSession: () => [{}, {}, {}, {}],
    } satisfies Pick<BackgroundManager, "getTasksByParentSession"> & {
      getConcurrencyCounts?: (modelOrUndefined?: string) => { running: number; queued: number }
      listTasksByParentSession?: (sessionID: string) => unknown[]
    }

    // when
    const result = await aggregateStatus("team-run-2", config, backgroundManager)

    // then
    expect(result.concurrency.runningOnSameModel).toBe(5)
    expect(result.concurrency.queuedOnSameModel).toBe(3)
    expect(result.concurrency.teamRunIdSpecific).toBe(4)
  })
})
