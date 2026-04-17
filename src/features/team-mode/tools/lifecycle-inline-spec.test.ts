/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "node:crypto"

import type { ToolContext } from "@opencode-ai/plugin/tool"

import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import { normalizeTeamSpecInput } from "../team-registry/team-spec-input-normalizer"
import type { RuntimeState, TeamSpec } from "../types"

const runtimes = new Map<string, RuntimeState>()
let nextTeamRunNumber = 1

function clone<TValue>(value: TValue): TValue {
  return structuredClone(value)
}

function createToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    messageID: randomUUID(),
    agent: "test-agent",
    directory: "/project",
    worktree: "/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => undefined,
  }
}

function createRuntimeState(spec: TeamSpec, leadSessionId: string, teamRunId: string): RuntimeState {
  return {
    version: 1,
    teamRunId,
    teamName: spec.name,
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId,
    shutdownRequests: [],
    bounds: { maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 10000, maxWallClockMinutes: 120, maxMemberTurns: 500 },
    members: spec.members.map((member) => ({
      name: member.name,
      sessionId: member.name === spec.leadAgentId ? undefined : `${member.name}-session`,
      tmuxPaneId: undefined,
      agentType: member.name === spec.leadAgentId ? "leader" : "general-purpose",
      status: "running",
      color: member.color,
      worktreePath: member.worktreePath,
      lastInjectedTurnMarker: `turn:${member.name}`,
      pendingInjectedMessageIds: [`msg:${member.name}`],
    })),
  }
}

const createTeamRunMock = mock(async (spec: TeamSpec, leadSessionId: string) => {
  const teamRunId = `team-run-${nextTeamRunNumber++}`
  const runtimeState = createRuntimeState(spec, leadSessionId, teamRunId)
  runtimes.set(teamRunId, runtimeState)
  return clone(runtimeState)
})

mock.module("../team-runtime/create", () => ({ createTeamRun: createTeamRunMock }))
mock.module("../team-registry/loader", () => ({
  loadTeamSpec: mock(async () => {
    throw new Error("loadTeamSpec should not be called for inline specs")
  }),
  normalizeTeamSpecInput,
}))
mock.module("../team-state-store/store", () => ({
  listActiveTeams: mock(async () => []),
  loadRuntimeState: mock(async () => {
    throw new Error("loadRuntimeState should not be called")
  }),
}))

const { createTeamCreateTool } = await import("./lifecycle")

const config = TeamModeConfigSchema.parse({ enabled: true })

describe("createTeamCreateTool inline_spec normalization", () => {
  beforeEach(() => {
    runtimes.clear()
    nextTeamRunNumber = 1
    createTeamRunMock.mockClear()
  })

  test("accepts inline_spec objects and auto-assigns missing member names", async () => {
    // given
    const teamCreateTool = createTeamCreateTool(config, {} as never)
    const inlineSpec = {
      name: "alpha-team",
      lead: { kind: "subagent_type", subagent_type: "sisyphus" },
      members: [
        { kind: "category", category: "quick", prompt: "Quick scout the workspace for entrypoints." },
        { kind: "subagent_type", subagent_type: "atlas" },
      ],
    }

    // when
    const result = JSON.parse(await teamCreateTool.execute({ inline_spec: inlineSpec }, createToolContext("lead-session")))
    const firstCall = createTeamRunMock.mock.calls[0]

    // then
    expect(firstCall?.[0]).toMatchObject({
      leadAgentId: "lead",
      members: [
        { name: "lead", kind: "subagent_type", subagent_type: "sisyphus" },
        { name: "quick-1", kind: "category", category: "quick" },
        { name: "atlas-1", kind: "subagent_type", subagent_type: "atlas" },
      ],
    })
    expect(firstCall?.[1]).toBe("lead-session")
    expect(result.runtimeState.members.map((member: { name: string }) => member.name)).toEqual(["lead", "quick-1", "atlas-1"])
  })

  test("accepts stringified inline_spec values from tool calling", async () => {
    // given
    const teamCreateTool = createTeamCreateTool(config, {} as never)
    const inlineSpec = JSON.stringify({
      name: "ccapi-explorers-v2",
      lead: { kind: "subagent_type", subagent_type: "sisyphus" },
      members: [
        { kind: "category", category: "quick", prompt: "Quick scout: survey ccapi workspace structure." },
        { kind: "category", category: "deep", prompt: "Deep dive ccapi-cf." },
        { kind: "category", category: "deep", prompt: "Deep dive ccapi-cf-proxy." },
      ],
    })

    // when
    const result = JSON.parse(await teamCreateTool.execute({ inline_spec: inlineSpec }, createToolContext("lead-session")))

    // then
    expect(result.runtimeState.members.map((member: { name: string }) => member.name)).toEqual(["lead", "quick-1", "deep-1", "deep-2"])
    expect(result.runtimeState.teamName).toBe("ccapi-explorers-v2")
  })
})
