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
    streamer.dispose()

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(2)
    const fifoPath = "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo"
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, fifoPath, "early")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, fifoPath, " late")
  })

  test("polling flushes a single message.part.updated that lands before mapping even if no later event arrives", async () => {
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
            id: "part-solo",
            sessionID: "member-session",
            messageID: "message-solo",
            type: "text",
            text: "solo-cumulative",
          },
        },
      },
    })
    expect(writeTeamSessionFifoMock).not.toHaveBeenCalled()
    mappingReady = true

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    streamer.dispose()

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(1)
    expect(writeTeamSessionFifoMock).toHaveBeenCalledWith("/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "solo-cumulative")
  })

  test("polling flushes a single message.part.delta that lands before mapping even if no later event arrives", async () => {
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
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-solo-delta", field: "text", delta: "solo-delta-only" },
      },
    })
    expect(writeTeamSessionFifoMock).not.toHaveBeenCalled()
    mappingReady = true

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    streamer.dispose()

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(1)
    expect(writeTeamSessionFifoMock).toHaveBeenCalledWith("/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "solo-delta-only")
  })

  test("does not advance dedupe state when write fails so later cumulative update replays the full text", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active" as const,
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    let failFirstWrite = true
    writeTeamSessionFifoMock.mockImplementation(async () => {
      if (failFirstWrite) {
        failFirstWrite = false
        throw new Error("simulated transient write failure")
      }
    })
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-retry",
            sessionID: "member-session",
            messageID: "message-retry",
            type: "text",
            text: "abc",
          },
        },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-retry",
            sessionID: "member-session",
            messageID: "message-retry",
            type: "text",
            text: "abcdef",
          },
        },
      },
    })
    streamer.dispose()

    // then
    const fifoPath = "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo"
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(3)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, fifoPath, "abc")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, fifoPath, "abc")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(3, fifoPath, "def")
  })

  test("does not lose buffered events after the second drained write fails and retries them in order", async () => {
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
    let writeCallCount = 0
    writeTeamSessionFifoMock.mockImplementation(async () => {
      writeCallCount += 1
      if (writeCallCount === 2) {
        const transient: Error & { code?: string } = new Error("EPIPE")
        transient.code = "EPIPE"
        throw transient
      }
    })
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-a", field: "text", delta: "A" },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-b", field: "text", delta: "B" },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-c", field: "text", delta: "C" },
      },
    })
    expect(writeTeamSessionFifoMock).not.toHaveBeenCalled()

    mappingReady = true

    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-d", field: "text", delta: "D" },
      },
    })

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    streamer.dispose()

    // then
    const fifoPath = "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo"
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(5)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, fifoPath, "A")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, fifoPath, "B")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(3, fifoPath, "B")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(4, fifoPath, "C")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(5, fifoPath, "D")
  })

  test("defers the current event when a buffered drain fails so stream order is preserved on retry", async () => {
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
    let failNext = true
    writeTeamSessionFifoMock.mockImplementation(async () => {
      if (failNext) {
        failNext = false
        const transient: Error & { code?: string } = new Error("EPIPE")
        transient.code = "EPIPE"
        throw transient
      }
    })
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-a", field: "text", delta: "A" },
      },
    })
    expect(writeTeamSessionFifoMock).not.toHaveBeenCalled()

    mappingReady = true

    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-b", field: "text", delta: "B" },
      },
    })
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(1)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "A")

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    streamer.dispose()

    // then
    const fifoPath = "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo"
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(3)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, fifoPath, "A")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, fifoPath, "A")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(3, fifoPath, "B")
  })

  test("buffers message.part.delta events that arrive before the runtime mapping and replays them in order", async () => {
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
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-race-delta", field: "text", delta: "early-" },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-race-delta", field: "text", delta: "mid-" },
      },
    })
    expect(writeTeamSessionFifoMock).not.toHaveBeenCalled()

    mappingReady = true

    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-race-delta", field: "text", delta: "late" },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(3)
    const fifoPath = "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo"
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, fifoPath, "early-")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, fifoPath, "mid-")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(3, fifoPath, "late")
  })

  test("clears buffered deltas on session.deleted so stale replay cannot land on a recycled sessionID", async () => {
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
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-x", field: "text", delta: "stale" },
      },
    })
    await streamer.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "member-session" } as never },
      },
    })
    mappingReady = true
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-y", field: "text", delta: "fresh" },
      },
    })

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(1)
    expect(writeTeamSessionFifoMock).toHaveBeenCalledWith("/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "fresh")
  })

  test("does not restore cleared dedupe state when session.deleted arrives during an in-flight write", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active" as const,
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    let releaseSecondWrite: (() => void) | undefined
    const secondWriteGate = new Promise<void>((resolve) => {
      releaseSecondWrite = resolve
    })
    let callCount = 0
    writeTeamSessionFifoMock.mockImplementation(async () => {
      callCount += 1
      if (callCount === 2) await secondWriteGate
    })
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { id: "part-a", sessionID: "member-session", messageID: "msg-a", type: "text", text: "A\n" },
        },
      },
    })
    const gatedEventPromise = streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { id: "part-a", sessionID: "member-session", messageID: "msg-a", type: "text", text: "A\nB\n" },
        },
      },
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    await streamer.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "member-session" } as never },
      },
    })
    releaseSecondWrite?.()
    await gatedEventPromise
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: { id: "part-a", sessionID: "member-session", messageID: "msg-a", type: "text", text: "A\nB\nC\n" },
        },
      },
    })
    streamer.dispose()

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(3)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "A\n")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "B\n")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(3, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "A\nB\nC\n")
  })

  test("does not write a drained partID that was removed mid-drain during another partID's in-flight write", async () => {
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
    let releaseFirstWrite: (() => void) | undefined
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let callCount = 0
    writeTeamSessionFifoMock.mockImplementation(async () => {
      callCount += 1
      if (callCount === 1) await firstWriteGate
    })
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-a", field: "text", delta: "AA" },
      },
    })
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-b", field: "text", delta: "BB" },
      },
    })
    mappingReady = true
    const drainPromise = streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-a", field: "text", delta: "AAA" },
      },
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    await streamer.event({
      event: {
        type: "message.part.removed",
        properties: { sessionID: "member-session", messageID: "msg-b", partID: "part-b" },
      },
    })
    releaseFirstWrite?.()
    await drainPromise
    streamer.dispose()

    // then
    const fifoPath = "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo"
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(2)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, fifoPath, "AA")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, fifoPath, "AAA")
  })

  test("lifecycle stop is reversible so a later session can still use the polling rescue", async () => {
    // given
    let mappingReady = true
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
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-x", field: "text", delta: "early\n" },
      },
    })
    await streamer.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: "member-session" } as never },
      },
    })
    mappingReady = false
    await streamer.event({
      event: {
        type: "message.part.delta",
        properties: { sessionID: "member-session", partID: "part-y", field: "text", delta: "stranded\n" },
      },
    })
    mappingReady = true
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
    streamer.dispose()

    // then
    const fifoPath = "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo"
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(2)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, fifoPath, "early\n")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(2, fifoPath, "stranded\n")
  })

  test("skips state mutation when message.part.removed arrives for the drained partID during write", async () => {
    // given
    const listActiveTeams = mock(async () => [{
      teamRunId: "11111111-1111-4111-8111-111111111111",
      teamName: "team-alpha",
      status: "active" as const,
      memberCount: 1,
      scope: "project" as const,
    }])
    const loadRuntimeState = mock(async () => createRuntimeState())
    let releaseSecondWrite: (() => void) | undefined
    const secondWriteGate = new Promise<void>((resolve) => {
      releaseSecondWrite = resolve
    })
    let callCount = 0
    writeTeamSessionFifoMock.mockImplementation(async () => {
      callCount += 1
      if (callCount === 2) await secondWriteGate
    })
    const config = TeamModeConfigSchema.parse({ enabled: true, tmux_visualization: true })
    const streamer = createTeamSessionStreamer(config, { listActiveTeams, loadRuntimeState })

    // when
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-a",
            sessionID: "member-session",
            messageID: "msg-a",
            type: "text",
            text: "first-wave\n",
          },
        },
      },
    })
    const slowEvent = streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-a",
            sessionID: "member-session",
            messageID: "msg-a",
            type: "text",
            text: "first-wave\nin-flight\n",
          },
        },
      },
    })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    await streamer.event({
      event: {
        type: "message.part.removed",
        properties: { sessionID: "member-session", messageID: "msg-a", partID: "part-a" },
      },
    })
    releaseSecondWrite?.()
    await slowEvent
    await streamer.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-a",
            sessionID: "member-session",
            messageID: "msg-a",
            type: "text",
            text: "first-wave\nin-flight\n",
          },
        },
      },
    })
    streamer.dispose()

    // then
    expect(writeTeamSessionFifoMock).toHaveBeenCalledTimes(3)
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(1, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "first-wave\n")
    expect(writeTeamSessionFifoMock).toHaveBeenNthCalledWith(3, "/tmp/omo-team/11111111-1111-4111-8111-111111111111/member-a.fifo", "first-wave\nin-flight\n")
  })
})
