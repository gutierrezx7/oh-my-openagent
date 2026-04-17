/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { RuntimeState } from "../../features/team-mode/types"

const writeTeamSessionFifoMock = mock(async (_fifoPath: string, _text: string) => undefined)

mock.module("./fifo-writer", () => ({ writeTeamSessionFifo: writeTeamSessionFifoMock }))

import { createTeamSessionStreamer } from "./hook"

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
      {
        name: "member-a",
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

describe("createTeamSessionStreamer", () => {
  beforeEach(() => {
    writeTeamSessionFifoMock.mockClear()
  })

  test("writes only appended text for matching session updates", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active",
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "member-session",
            messageID: "message-1",
            type: "text",
            text: "hello",
          },
        },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-1",
            sessionID: "member-session",
            messageID: "message-1",
            type: "text",
            text: "hello world",
          },
        },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(2)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "hello")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", " world")
    expect(listActiveTeams).toHaveBeenCalledTimes(1)
    expect(loadRuntimeState).toHaveBeenCalledTimes(1)
  })

  test("streams incremental message.part.delta events to member fifo", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active",
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "member-session",
          partID: "part-delta",
          field: "text",
          delta: "chunk-one ",
        },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "member-session",
          partID: "part-delta",
          field: "text",
          delta: "chunk-two",
        },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(2)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "chunk-one ")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "chunk-two")
  })

  test("ignores delta events for non-text fields", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active",
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "member-session",
          partID: "part-other",
          field: "tool",
          delta: "ignored",
        },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).not.toHaveBeenCalled()
  })

  test("does not duplicate output when message.part.delta precedes message.part.updated for the same part", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active",
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "member-session",
          partID: "part-mixed",
          field: "text",
          delta: "hello",
        },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-mixed",
            sessionID: "member-session",
            messageID: "message-x",
            type: "text",
            text: "hello world",
          },
        },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(2)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "hello")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", " world")
  })

  test("drops delta events that carry no partID (rely on later cumulative updated to replay)", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active",
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "member-session",
          field: "text",
          delta: "orphan",
        },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-cumulative",
            sessionID: "member-session",
            messageID: "message-y",
            type: "text",
            text: "orphan full",
          },
        },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(1)
    expect(writeTeamSessionFifoMock).toHaveBeenCalledWith("/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "orphan full")
  })

  test("does not lose text when runtime state mapping is not yet available (pre-mapping race)", async () => {
    // given
    let mappingReady = false
    const listActiveTeams = mock(async () => mappingReady ? [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active" as const,
      memberCount: 1,
      scope: "project" as const,
    }] : [])
    const loadRuntimeState = mock(async () => createRuntimeState())
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-race",
            sessionID: "member-session",
            messageID: "message-z",
            type: "text",
            text: "early",
          },
        },
      },
    })
    expect(writeTeamSessionFifoMock).not.toHaveBeenCalled()

    mappingReady = true

    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-race",
            sessionID: "member-session",
            messageID: "message-z",
            type: "text",
            text: "early late",
          },
        },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(1)
    expect(writeTeamSessionFifoMock).toHaveBeenCalledWith("/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "early late")
  })
})
