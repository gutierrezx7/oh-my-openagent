import { beforeEach, describe, expect, mock, test } from "bun:test"

let listActiveTeamsCalls = 0
let listActiveTeamsImplementation: typeof import("../../features/team-mode/team-state-store").listActiveTeams = async () => []
let loadRuntimeStateImplementation: typeof import("../../features/team-mode/team-state-store").loadRuntimeState = async () => {
  throw new Error("loadRuntimeStateImplementation not set")
}

mock.module("../../features/team-mode/team-state-store", () => ({
  listActiveTeams: (...args: Parameters<typeof listActiveTeamsImplementation>) => {
    listActiveTeamsCalls += 1
    return listActiveTeamsImplementation(...args)
  },
  loadRuntimeState: (...args: Parameters<typeof loadRuntimeStateImplementation>) => loadRuntimeStateImplementation(...args),
}))

import type { PluginInput } from "@opencode-ai/plugin"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import type { RuntimeState } from "../../features/team-mode/types"
import { createTeamToolGating } from "./hook"

function createConfig(overrides?: Partial<TeamModeConfig>): TeamModeConfig {
  return {
    enabled: true,
    tmux_visualization: false,
    max_parallel_members: 4,
    max_members: 8,
    max_messages_per_run: 10_000,
    max_wall_clock_minutes: 120,
    max_member_turns: 500,
    base_dir: "/tmp/team-mode",
    member_delegate_task_budget: 1,
    message_payload_max_bytes: 32_768,
    recipient_unread_max_bytes: 262_144,
    mailbox_poll_interval_ms: 3_000,
    ...overrides,
  }
}

function createRuntimeState(): RuntimeState {
  return {
    version: 1,
    teamRunId: "11111111-1111-4111-8111-111111111111",
    teamName: "team-alpha",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: "lead-session",
    members: [
      { name: "m1", sessionId: "member-session-1", agentType: "general-purpose", status: "running", pendingInjectedMessageIds: [] },
      { name: "m2", sessionId: "member-session-2", agentType: "general-purpose", status: "running", pendingInjectedMessageIds: [] },
    ],
    shutdownRequests: [],
    bounds: { maxMembers: 8, maxParallelMembers: 4, maxMessagesPerRun: 10_000, maxWallClockMinutes: 120, maxMemberTurns: 500 },
  }
}

function setTeams(...runtimeStates: RuntimeState[]): void {
  const runtimeStatesById = new Map(runtimeStates.map((runtimeState) => [runtimeState.teamRunId, runtimeState]))
  listActiveTeamsImplementation = async () => runtimeStates.map(({ teamRunId, teamName, status }) => ({ teamRunId, teamName, status }))
  loadRuntimeStateImplementation = async (teamRunId) => {
    const runtimeState = runtimeStatesById.get(teamRunId)
    if (!runtimeState) {
      throw new Error(`unknown runtime state: ${teamRunId}`)
    }
    return runtimeState
  }
}

async function runHook(tool: string, sessionID: string, args: Record<string, unknown>, config?: Partial<TeamModeConfig>): Promise<void> {
  const hook = createTeamToolGating({ directory: "/tmp/team-mode" } as PluginInput, createConfig(config))
  await hook["tool.execute.before"]?.({ tool, sessionID, callID: "call-1" }, { args })
}

describe("createTeamToolGating", () => {
  beforeEach(() => {
    listActiveTeamsCalls = 0
    setTeams()
  })

  test("allows a fresh session to call team_create", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("team_create", "fresh-session", {})

    // then
    await expect(result).resolves.toBeUndefined()
  })

  test("rejects team_create when the caller is already a team member", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("team_create", "member-session-1", {})

    // then
    await expect(result).rejects.toThrow("team_create denied: session is already a participant of team 11111111-1111-4111-8111-111111111111")
  })

  test("allows the target member to self-approve shutdown", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("team_approve_shutdown", "member-session-1", { teamRunId: "11111111-1111-4111-8111-111111111111", memberName: "m1" })

    // then
    await expect(result).resolves.toBeUndefined()
  })

  test("allows the lead to force-approve shutdown", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("team_approve_shutdown", "lead-session", { teamRunId: "11111111-1111-4111-8111-111111111111", memberName: "m1" })

    // then
    await expect(result).resolves.toBeUndefined()
  })

  test("rejects a non-target member from approving shutdown", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("team_approve_shutdown", "member-session-2", { teamRunId: "11111111-1111-4111-8111-111111111111", memberName: "m1" })

    // then
    await expect(result).rejects.toThrow("team_approve_shutdown: caller must be target member or team lead")
  })

  test("blocks delegate-task for members when budget is zero", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("delegate-task", "member-session-1", {}, { member_delegate_task_budget: 0 })

    // then
    await expect(result).rejects.toThrow("member delegate-task budget exhausted")
  })

  test("allows team_delete for the lead of the target team", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("team_delete", "lead-session", { teamRunId: "11111111-1111-4111-8111-111111111111" })

    // then
    await expect(result).resolves.toBeUndefined()
  })

  test("no-ops for unrelated tools without querying team state", async () => {
    // given
    setTeams(createRuntimeState())

    // when
    const result = runHook("write", "fresh-session", {})

    // then
    await expect(result).resolves.toBeUndefined()
    expect(listActiveTeamsCalls).toBe(0)
  })
})
