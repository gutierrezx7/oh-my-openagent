/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"

import type { ToolContext } from "@opencode-ai/plugin/tool"

import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import { normalizeTeamSpecInput } from "../team-registry/team-spec-input-normalizer"
import type { RuntimeState, TeamSpec } from "../types"

const runtimes = new Map<string, RuntimeState>()
const teamRuns = new Map<string, string>()
let nextTeamRunNumber = 1

function clone<TValue>(value: TValue): TValue {
  return structuredClone(value)
}

function parseToolResult<TValue>(value: string): TValue {
  return JSON.parse(value) as TValue
}

type TestToolContext = ToolContext & { client: Record<string, never> }

function createToolContext(sessionID: string): TestToolContext {
  return {
    sessionID,
    messageID: randomUUID(),
    agent: "test-agent",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => undefined,
    client: {},
  }
}

function getLatestShutdownRequest(runtimeState: RuntimeState, memberName: string): RuntimeState["shutdownRequests"][number] | undefined {
  for (let index = runtimeState.shutdownRequests.length - 1; index >= 0; index -= 1) {
    const shutdownRequest = runtimeState.shutdownRequests[index]
    if (shutdownRequest?.memberId === memberName) {
      return shutdownRequest
    }
  }
}

function createSpec(): TeamSpec {
  return { version: 1, name: "alpha-team", createdAt: 1, leadAgentId: "lead", members: [{ kind: "category", name: "lead", category: "deep", prompt: "Lead the assigned work", backendType: "in-process", isActive: true }, { kind: "category", name: "member-a", category: "quick", prompt: "Do the assigned work", backendType: "in-process", isActive: true }] }
}

function createRuntimeState(spec: TeamSpec, leadSessionId: string, teamRunId: string): RuntimeState {
  return { version: 1, teamRunId, teamName: spec.name, specSource: "project", createdAt: 1, status: "active", leadSessionId, shutdownRequests: [], bounds: { maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 10000, maxWallClockMinutes: 120, maxMemberTurns: 500 }, members: spec.members.map((member) => ({ name: member.name, sessionId: member.name === spec.leadAgentId ? undefined : `${member.name}-session`, tmuxPaneId: undefined, agentType: member.name === spec.leadAgentId ? "leader" : "general-purpose", status: member.name === spec.leadAgentId ? "running" : "running", color: member.color, worktreePath: member.worktreePath, lastInjectedTurnMarker: `turn:${member.name}`, pendingInjectedMessageIds: [`msg:${member.name}`] })) }
}

function requireRuntime(teamRunId: string): RuntimeState {
  const runtimeState = runtimes.get(teamRunId)
  if (!runtimeState) throw new Error(`missing runtime ${teamRunId}`)
  return runtimeState
}

const createTeamRunMock = mock(async (spec: TeamSpec, leadSessionId: string) => {
  const key = `${spec.name}:${leadSessionId}`
  const existingTeamRunId = teamRuns.get(key)
  if (existingTeamRunId) return clone(requireRuntime(existingTeamRunId))
  const teamRunId = `team-run-${nextTeamRunNumber++}`
  teamRuns.set(key, teamRunId)
  const runtimeState = createRuntimeState(spec, leadSessionId, teamRunId)
  runtimes.set(teamRunId, runtimeState)
  return clone(runtimeState)
})
const deleteTeamMock = mock(async (teamRunId: string) => {
  const runtimeState = requireRuntime(teamRunId)
  if (runtimeState.members.some((member) => member.agentType !== "leader" && member.status !== "shutdown_approved" && member.status !== "completed" && member.status !== "errored")) {
    throw new Error("members still active")
  }
  runtimes.delete(teamRunId)
  return { removedWorktrees: [], removedLayout: false }
})
const requestShutdownOfMemberMock = mock(async (teamRunId: string, targetMemberName: string, requesterName: string) => {
  requireRuntime(teamRunId).shutdownRequests.push({ memberId: targetMemberName, requesterName, requestedAt: Date.now() })
})
const approveShutdownMock = mock(async (teamRunId: string, memberName: string) => {
  const runtimeState = requireRuntime(teamRunId)
  const request = getLatestShutdownRequest(runtimeState, memberName)
  if (request) request.approvedAt = Date.now()
  const member = runtimeState.members.find((candidate) => candidate.name === memberName)
  if (member) member.status = "shutdown_approved"
})
const rejectShutdownMock = mock(async (teamRunId: string, memberName: string, reason: string) => {
  const request = getLatestShutdownRequest(requireRuntime(teamRunId), memberName)
  if (request) {
    request.rejectedAt = Date.now()
    request.rejectedReason = reason
  }
})
const loadTeamSpecMock = mock(async () => createSpec())
const listActiveTeamsMock = mock(async () => Array.from(runtimes.values()).map((runtimeState) => ({ teamRunId: runtimeState.teamRunId, teamName: runtimeState.teamName, status: runtimeState.status })))
const loadRuntimeStateMock = mock(async (teamRunId: string) => clone(requireRuntime(teamRunId)))

mock.module("../team-runtime/create", () => ({ createTeamRun: createTeamRunMock }))
mock.module("../team-runtime/shutdown", () => ({ approveShutdown: approveShutdownMock, deleteTeam: deleteTeamMock, rejectShutdown: rejectShutdownMock, requestShutdownOfMember: requestShutdownOfMemberMock }))
mock.module("../team-registry/loader", () => ({ loadTeamSpec: loadTeamSpecMock, normalizeTeamSpecInput }))
mock.module("../team-state-store/store", () => ({ listActiveTeams: listActiveTeamsMock, loadRuntimeState: loadRuntimeStateMock }))

const { createTeamApproveShutdownTool, createTeamCreateTool, createTeamDeleteTool, createTeamRejectShutdownTool, createTeamShutdownRequestTool } = await import("./lifecycle")

const config = TeamModeConfigSchema.parse({ enabled: true })

describe("team lifecycle tools", () => {
  beforeEach(() => {
    runtimes.clear()
    teamRuns.clear()
    nextTeamRunNumber = 1
    for (const mockedFunction of [createTeamRunMock, deleteTeamMock, requestShutdownOfMemberMock, approveShutdownMock, rejectShutdownMock, loadTeamSpecMock, listActiveTeamsMock, loadRuntimeStateMock]) mockedFunction.mockClear()
  })

  test("team_create returns teamRunId and sanitized runtimeState for inline specs", async () => {
    // given
    const teamCreateTool = createTeamCreateTool(config, {} as never)

    // when
    const result = parseToolResult<{ teamRunId: string; runtimeState: RuntimeState }>(await teamCreateTool.execute({ inline_spec: createSpec() }, createToolContext("lead-session")))

    // then
    expect(result.teamRunId).toBe("team-run-1")
    expect(result.runtimeState.status).toBe("active")
    expect(result.runtimeState.members).toHaveLength(2)
    expect(result.runtimeState.members[0]).not.toHaveProperty("lastInjectedTurnMarker")
    expect(result.runtimeState.members[0]).not.toHaveProperty("pendingInjectedMessageIds")
  })

  test("team_create normalizes inline lead shorthand before creating the runtime", async () => {
    // given
    const teamCreateTool = createTeamCreateTool(config, {} as never)
    const inlineSpec = {
      name: "alpha-team",
      lead: { kind: "subagent_type", subagent_type: "sisyphus" },
      members: [{ kind: "category", name: "member-a", category: "quick", prompt: "Do the assigned work" }],
    }

    // when
    const result = parseToolResult<{ runtimeState: RuntimeState }>(await teamCreateTool.execute({ inline_spec: inlineSpec }, createToolContext("lead-session")))

    // then
    expect(createTeamRunMock).toHaveBeenCalledWith(expect.objectContaining({ leadAgentId: "lead" }), "lead-session", expect.anything(), config, expect.anything(), undefined)
    expect(result.runtimeState.members).toHaveLength(2)
    expect(result.runtimeState.members[0]).toMatchObject({ name: "lead", agentType: "leader" })
  })

  test("team_delete propagates active-member errors", async () => {
    // given
    const createTool = createTeamCreateTool(config, {} as never)
    const deleteTool = createTeamDeleteTool(config, {} as never)
    const created = parseToolResult<{ teamRunId: string }>(await createTool.execute({ inline_spec: createSpec() }, createToolContext("lead-session")))

    // when
    const result = deleteTool.execute({ teamRunId: created.teamRunId }, createToolContext("lead-session"))

    // then
    await expect(result).rejects.toThrow("members still active")
  })

  test("team_create is idempotent for the same spec and lead session", async () => {
    // given
    const teamCreateTool = createTeamCreateTool(config, {} as never)

    // when
    const firstResult = parseToolResult<{ teamRunId: string }>(await teamCreateTool.execute({ inline_spec: createSpec() }, createToolContext("lead-session")))
    const secondResult = parseToolResult<{ teamRunId: string }>(await teamCreateTool.execute({ inline_spec: createSpec() }, createToolContext("lead-session")))

    // then
    expect(firstResult.teamRunId).toBe(secondResult.teamRunId)
    expect(createTeamRunMock).toHaveBeenCalledTimes(2)
  })

  test("runs full lifecycle through create, request, approve, and delete", async () => {
    // given
    const createTool = createTeamCreateTool(config, {} as never)
    const requestTool = createTeamShutdownRequestTool(config)
    const approveTool = createTeamApproveShutdownTool(config)
    const deleteTool = createTeamDeleteTool(config, {} as never)
    const created = parseToolResult<{ teamRunId: string; runtimeState: RuntimeState }>(await createTool.execute({ inline_spec: createSpec() }, createToolContext("lead-session")))
    const memberSessionId = created.runtimeState.members.find((member) => member.name === "member-a")?.sessionId

    // when
    const requestResult = parseToolResult<{ status: string }>(await requestTool.execute({ teamRunId: created.teamRunId, targetMemberName: "member-a" }, createToolContext("lead-session")))
    const approveResult = parseToolResult<{ status: string }>(await approveTool.execute({ teamRunId: created.teamRunId, memberName: "member-a" }, createToolContext(memberSessionId ?? "member-a-session")))
    const deleteResult = parseToolResult<{ deleted: boolean }>(await deleteTool.execute({ teamRunId: created.teamRunId }, createToolContext("lead-session")))

    // then
    expect(requestResult.status).toBe("shutdown_requested")
    expect(approveResult.status).toBe("shutdown_approved")
    expect(deleteResult.deleted).toBe(true)
    expect(runtimes.has(created.teamRunId)).toBe(false)
  })

  test("team_reject_shutdown records the rejection reason", async () => {
    // given
    const createTool = createTeamCreateTool(config, {} as never)
    const requestTool = createTeamShutdownRequestTool(config)
    const rejectTool = createTeamRejectShutdownTool(config)
    const created = parseToolResult<{ teamRunId: string; runtimeState: RuntimeState }>(await createTool.execute({ teamName: "alpha-team" }, createToolContext("lead-session")))
    const memberSessionId = created.runtimeState.members.find((member) => member.name === "member-a")?.sessionId
    await requestTool.execute({ teamRunId: created.teamRunId, targetMemberName: "member-a" }, createToolContext("lead-session"))

    // when
    const result = parseToolResult<{ teamRunId: string; memberName: string; rejectedBy: string; reason: string; status: string }>(await rejectTool.execute({ teamRunId: created.teamRunId, memberName: "member-a", reason: "still working" }, createToolContext(memberSessionId ?? "member-a-session")))

    // then
    expect(result).toEqual({ teamRunId: created.teamRunId, memberName: "member-a", rejectedBy: "member-a", reason: "still working", status: "shutdown_rejected" })
    expect(getLatestShutdownRequest(requireRuntime(created.teamRunId), "member-a")).toEqual(expect.objectContaining({ rejectedReason: "still working", rejectedAt: expect.any(Number) }))
  })
})
