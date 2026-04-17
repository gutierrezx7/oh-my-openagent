/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import path from "node:path"

import { type ToolContext } from "@opencode-ai/plugin/tool"
import { TeamModeConfigSchema } from "../../../config/schema/team-mode"
import type { OpencodeClient } from "../../../tools/delegate-task/types"
import { BroadcastNotPermittedError } from "../team-mailbox/send"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"
import { createRuntimeState, saveRuntimeState } from "../team-state-store/store"
import { MessageSchema } from "../types"
import { createTeamSendMessageTool } from "./messaging"

const mockClient = {} as OpencodeClient

async function createFixtureBaseDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "team-send-message-"))
}

function createConfig(baseDir: string) {
  return TeamModeConfigSchema.parse({ base_dir: baseDir })
}

function createToolContext(sessionID: string, directory: string): ToolContext {
  return {
    sessionID,
    messageID: randomUUID(),
    agent: "test-agent",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => undefined,
  }
}

async function createTeamFixture() {
  const baseDir = await createFixtureBaseDir()
  const config = createConfig(baseDir)
  const leadSessionId = randomUUID()
  const memberOneSessionId = randomUUID()
  const memberTwoSessionId = randomUUID()

  const runtimeState = await createRuntimeState(
    {
      version: 1,
      name: "team-alpha",
        createdAt: Date.now(),
        leadAgentId: "team-lead",
        members: [
          { kind: "subagent_type", name: "team-lead", subagent_type: "sisyphus-junior", backendType: "in-process", isActive: true },
          { kind: "subagent_type", name: "m1", subagent_type: "sisyphus-junior", backendType: "in-process", isActive: true },
          { kind: "subagent_type", name: "m2", subagent_type: "sisyphus-junior", backendType: "in-process", isActive: true },
        ],
      },
    leadSessionId,
    "project",
    config,
  )

  runtimeState.leadSessionId = leadSessionId
  runtimeState.members[0].sessionId = leadSessionId
  runtimeState.members[1].sessionId = memberOneSessionId
  runtimeState.members[2].sessionId = memberTwoSessionId
  await saveRuntimeState(runtimeState, config)

  return {
    config,
      teamRunId: runtimeState.teamRunId,
      leadSessionId,
      memberOneSessionId,
      memberTwoSessionId,
      tool: createTeamSendMessageTool(config, mockClient),
      toolContext: (sessionID: string) => createToolContext(sessionID, baseDir),
    }
}

describe("createTeamSendMessageTool", () => {
  test("routes a member message to one recipient", async () => {
    // given
    const fixture = await createTeamFixture()

    // when
    const result = await fixture.tool.execute({
      teamRunId: fixture.teamRunId,
      to: "m2",
      body: "hello",
    }, fixture.toolContext(fixture.memberOneSessionId))
    const parsedResult = JSON.parse(result)

    // then
    expect(parsedResult.deliveredTo).toEqual(["m2"])
    const inboxDir = getInboxDir(resolveBaseDir(fixture.config), fixture.teamRunId, "m2")
    const [messageFile] = (await readdir(inboxDir)).filter((entry) => entry.endsWith(".json"))
    const message = MessageSchema.parse(JSON.parse(await readFile(path.join(inboxDir, messageFile), "utf8")))
    expect(message.from).toBe("m1")
  })

  test("gates broadcast to the lead and fans out to active members", async () => {
    // given
    const fixture = await createTeamFixture()

    // when
    const nonLeadResult = fixture.tool.execute({
      teamRunId: fixture.teamRunId,
      to: "*",
      body: "hello everyone",
    }, fixture.toolContext(fixture.memberOneSessionId))

    // then
    expect(nonLeadResult).rejects.toBeInstanceOf(BroadcastNotPermittedError)

    // when
    const leadResult = await fixture.tool.execute({
      teamRunId: fixture.teamRunId,
      to: "*",
      body: "team announcement",
      kind: "announcement",
    }, fixture.toolContext(fixture.leadSessionId))
    const parsedLeadResult = JSON.parse(leadResult)

    // then
    expect(parsedLeadResult.deliveredTo).toEqual(["team-lead", "m1", "m2"])
    const memberOneInbox = await readdir(getInboxDir(resolveBaseDir(fixture.config), fixture.teamRunId, "m1"))
    const memberTwoInbox = await readdir(getInboxDir(resolveBaseDir(fixture.config), fixture.teamRunId, "m2"))
    expect(memberOneInbox.filter((entry) => entry.endsWith(".json"))).toHaveLength(1)
    expect(memberTwoInbox.filter((entry) => entry.endsWith(".json"))).toHaveLength(1)
  })

  test("rejects shutdown_request kind", async () => {
    // given
    const fixture = await createTeamFixture()

    // when
    const result = fixture.tool.execute({
      teamRunId: fixture.teamRunId,
      to: "m1",
      body: "stop",
      kind: "shutdown_request",
    }, fixture.toolContext(fixture.leadSessionId))

    // then
    expect(result).rejects.toBeInstanceOf(Error)
  })
})
