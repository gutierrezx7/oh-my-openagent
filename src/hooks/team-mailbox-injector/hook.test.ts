import { beforeEach, describe, expect, it, mock } from "bun:test"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { InjectionResult } from "../../features/team-mode/team-mailbox/poll"
import type { RuntimeState } from "../../features/team-mode/types"

type ActiveTeam = {
  teamRunId: string
  teamName: string
  status: string
}

type PollCall = {
  sessionID: string
  memberName: string
  teamRunId: string
  turnMarker: string
}

let activeTeams: ActiveTeam[] = []
let runtimeStates = new Map<string, RuntimeState>()
let pollCalls: PollCall[] = []
let pollResults: InjectionResult[] = []

mock.module("../../features/team-mode/team-state-store/store", () => ({
  listActiveTeams: async () => activeTeams,
  loadRuntimeState: async (teamRunId: string) => {
    const runtimeState = runtimeStates.get(teamRunId)
    if (runtimeState === undefined) {
      throw new Error(`missing runtime state for ${teamRunId}`)
    }

    return runtimeState
  },
}))

mock.module("../../features/team-mode/team-mailbox/poll", () => ({
  pollAndBuildInjection: async (
    sessionID: string,
    memberName: string,
    teamRunId: string,
    _config: unknown,
    turnMarker: string,
  ) => {
    pollCalls.push({ sessionID, memberName, teamRunId, turnMarker })
    return pollResults.shift() ?? {
      injected: false,
      messageIds: [],
      reason: "no unread",
    }
  },
}))

const { createTeamMailboxInjector } = await import("./hook")

function createRuntimeState(sessionID: string): RuntimeState {
  return {
    version: 1,
    teamRunId: "team-run-1",
    teamName: "team-alpha",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: "lead-session",
    members: [
      {
        name: "member-a",
        sessionId: sessionID,
        agentType: "general-purpose",
        status: "running",
        lastInjectedTurnMarker: undefined,
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

function createHook() {
  return createTeamMailboxInjector(
    {},
    TeamModeConfigSchema.parse({ enabled: true }),
  )
}

function createOutput(sessionID: string) {
  return {
    messages: [
      {
        info: {
          role: "user",
          sessionID,
        },
        parts: [{ type: "text", text: "original message" }],
      },
    ],
  }
}

describe("createTeamMailboxInjector", () => {
  beforeEach(() => {
    activeTeams = []
    runtimeStates = new Map<string, RuntimeState>()
    pollCalls = []
    pollResults = []
  })

  it("returns the input unchanged for a non-member session", async () => {
    // given
    const hook = createHook()
    const output = createOutput("session-non-member")
    const originalMessages = structuredClone(output.messages)

    // when
    await hook["experimental.chat.messages.transform"]?.(
      { sessionID: "session-non-member" },
      output,
    )

    // then
    expect(output.messages).toEqual(originalMessages)
    expect(pollCalls).toHaveLength(0)
  })

  it("prepends an envelope as a user-role message for a member session", async () => {
    // given
    const hook = createHook()
    activeTeams = [
      {
        teamRunId: "team-run-1",
        teamName: "team-alpha",
        status: "active",
      },
    ]
    runtimeStates.set("team-run-1", createRuntimeState("session-member"))
    pollResults = [
      {
        injected: true,
        content: '<peer_message from="lead" timestamp="1">hello</peer_message>',
        messageIds: ["uuid1"],
      },
    ]
    const output = createOutput("session-member")

    // when
    await hook["experimental.chat.messages.transform"]?.(
      { sessionID: "session-member" },
      output,
    )

    // then
    expect(output.messages).toHaveLength(2)
    expect(output.messages[0]).toEqual({
      info: {
        role: "user",
        sessionID: "session-member",
      },
      parts: [
        {
          type: "text",
          text: '<peer_message from="lead" timestamp="1">hello</peer_message>',
          synthetic: true,
        },
      ],
    })
    expect(output.messages.map((message) => message.info.role)).not.toContain("system")
    expect(pollCalls).toEqual([
      {
        sessionID: "session-member",
        memberName: "member-a",
        teamRunId: "team-run-1",
        turnMarker: "session-member#1",
      },
    ])
  })

  it("does not inject twice for the same turn marker", async () => {
    // given
    const hook = createHook()
    activeTeams = [
      {
        teamRunId: "team-run-1",
        teamName: "team-alpha",
        status: "active",
      },
    ]
    runtimeStates.set("team-run-1", createRuntimeState("session-member"))
    pollResults = [
      {
        injected: true,
        content: '<peer_message from="lead" timestamp="1">hello</peer_message>',
        messageIds: ["uuid1"],
      },
      {
        injected: false,
        messageIds: [],
        reason: "already injected this turn",
      },
    ]
    const firstOutput = createOutput("session-member")
    const secondOutput = createOutput("session-member")
    const originalSecondMessages = structuredClone(secondOutput.messages)

    // when
    await hook["experimental.chat.messages.transform"]?.(
      { sessionID: "session-member" },
      firstOutput,
    )
    await hook["experimental.chat.messages.transform"]?.(
      { sessionID: "session-member" },
      secondOutput,
    )

    // then
    expect(firstOutput.messages).toHaveLength(2)
    expect(secondOutput.messages).toEqual(originalSecondMessages)
    expect(pollCalls[1]).toEqual({
      sessionID: "session-member",
      memberName: "member-a",
      teamRunId: "team-run-1",
      turnMarker: "session-member#1",
    })
  })
})
