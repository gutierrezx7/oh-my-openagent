/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import * as ackModule from "../../features/team-mode/team-mailbox/ack"
import { sendMessage } from "../../features/team-mode/team-mailbox/send"
import { getInboxDir, resolveBaseDir } from "../../features/team-mode/team-registry/paths"
import { loadRuntimeState, saveRuntimeState } from "../../features/team-mode/team-state-store/store"
import type { RuntimeState } from "../../features/team-mode/types"
import { createTeamIdleWakeHint } from "./team-idle-wake-hint"

const temporaryDirectories: string[] = []

async function createTemporaryBaseDir(): Promise<string> {
  const baseDir = await mkdtemp(path.join(tmpdir(), "team-idle-wake-hint-"))
  temporaryDirectories.push(baseDir)
  return baseDir
}

function createConfig(baseDir: string): TeamModeConfig {
  return TeamModeConfigSchema.parse({ base_dir: baseDir, enabled: true })
}

function createRuntimeState(teamRunId: string, pendingInjectedMessageIds: string[] = []): RuntimeState {
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
        status: "idle",
        pendingInjectedMessageIds,
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

async function seedUnreadMessage(
  teamRunId: string,
  config: TeamModeConfig,
  messageId: string,
  body: string,
  timestamp: number,
): Promise<void> {
  await sendMessage({
    version: 1,
    messageId,
    from: "lead",
    to: "worker",
    kind: "message",
    body,
    timestamp,
  }, teamRunId, config, { isLead: true, activeMembers: ["worker"] })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
    await rm(directoryPath, { recursive: true, force: true })
  }))
})

describe("createTeamIdleWakeHint", () => {
  test("sends a trigger-only wake hint when new unread mail exists", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    await seedRuntimeState(createRuntimeState(teamRunId), config)
    await seedUnreadMessage(teamRunId, config, randomUUID(), "first message body", 100)
    await seedUnreadMessage(teamRunId, config, randomUUID(), "second message body", 200)

    const promptInputs: Array<{
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
      query: { directory: string }
    }> = []
    const promptAsyncSpy = mock(async (input: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
      query: { directory: string }
    }) => {
      promptInputs.push(input)
      return {}
    })
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: { session: { promptAsync: promptAsyncSpy } },
    }, config)

    // when
    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "member-session" },
      },
    })
    
    // then
    expect(promptAsyncSpy).toHaveBeenCalledTimes(1)
    const promptInput = promptInputs[0]
    if (promptInput === undefined) {
      throw new Error("expected wake hint prompt input")
    }
    expect(promptInput.path).toEqual({ id: "member-session" })
    expect(promptInput.body.parts[0]?.text).toContain("2 new team messages")
    expect(promptInput.body.parts[0]?.text).not.toContain("first message body")
    expect(promptInput.body.parts[0]?.text).not.toContain("second message body")
  })

  test("acks pending messages on idle, moves files to processed, and clears pending ids", async () => {
    // given
    const baseDir = await createTemporaryBaseDir()
    const config = createConfig(baseDir)
    const teamRunId = randomUUID()
    const messageIds = [randomUUID(), randomUUID(), randomUUID()]
    await seedRuntimeState(createRuntimeState(teamRunId, messageIds), config)
    await seedUnreadMessage(teamRunId, config, messageIds[0], "one", 100)
    await seedUnreadMessage(teamRunId, config, messageIds[1], "two", 200)
    await seedUnreadMessage(teamRunId, config, messageIds[2], "three", 300)

    const ackSpy = spyOn(ackModule, "ackMessages")
    const promptAsyncSpy = mock(async (_input: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
      query: { directory: string }
    }) => {
      return {}
    })
    const handler = createTeamIdleWakeHint({
      directory: "/tmp/project",
      client: { session: { promptAsync: promptAsyncSpy } },
    }, config)

    // when
    await handler({
      event: {
        type: "session.idle",
        properties: { sessionID: "member-session" },
      },
    })

    // then
    expect(ackSpy).toHaveBeenCalledTimes(1)
    expect(ackSpy).toHaveBeenCalledWith(teamRunId, "worker", messageIds, config)
    expect(promptAsyncSpy).not.toHaveBeenCalled()

    const runtimeState = await loadRuntimeState(teamRunId, config)
    expect(runtimeState.members[0]?.pendingInjectedMessageIds).toEqual([])

    const inboxEntries = await readdir(getInboxDir(resolveBaseDir(config), teamRunId, "worker"))
    expect(inboxEntries).toContain("processed")

    const processedEntries = await readdir(path.join(getInboxDir(resolveBaseDir(config), teamRunId, "worker"), "processed"))
    expect(processedEntries.sort()).toEqual(messageIds.map((messageId) => `${messageId}.json`).sort())
  })
})
