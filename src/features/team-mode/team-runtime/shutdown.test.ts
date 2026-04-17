/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { access, mkdir, rm } from "node:fs/promises"

import { sendMessage } from "../team-mailbox/send"
import { getInboxDir, getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import { loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import {
  createFixture,
  createTestMessage,
  readInboxMessages,
  updateMemberStatuses,
} from "./shutdown-test-fixtures"

const canVisualizeMock = mock(() => true)
const removeTeamLayoutMock = mock(() => Promise.resolve())

mock.module("../team-layout-tmux/layout", () => ({
  canVisualize: canVisualizeMock,
  removeTeamLayout: removeTeamLayoutMock,
}))

const { approveShutdown, deleteTeam, rejectShutdown, requestShutdownOfMember } = await import("./shutdown")

describe("team-runtime shutdown", () => {
  const temporaryDirectories: string[] = []

  beforeEach(() => {
    canVisualizeMock.mockReset()
    canVisualizeMock.mockImplementation(() => true)
    removeTeamLayoutMock.mockClear()
    removeTeamLayoutMock.mockImplementation(() => Promise.resolve())
  })

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }))
  })

  test("refuses team deletion while non-lead members are still active", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "running",
      "member-b": "running",
    })

    // when
    const result = deleteTeam(fixture.teamRunId, fixture.config)

    // then
    await expect(result).rejects.toThrow("members still active")
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    expect(runtimeState.status).toBe("active")
    expect(runtimeState.members.filter((member) => member.agentType !== "leader").map((member) => member.status)).toEqual([
      "running",
      "running",
    ])
  })

  test("writes shutdown requests to the target inbox and records runtime metadata", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)

    // when
    await requestShutdownOfMember(fixture.teamRunId, "member-a", "lead", fixture.config)

    // then
    const inboxMessages = await readInboxMessages(fixture.teamRunId, "member-a", fixture.config)
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    expect(inboxMessages).toHaveLength(1)
    expect(inboxMessages[0]).toEqual(expect.objectContaining({
      from: "lead",
      to: "member-a",
      kind: "shutdown_request",
      body: "",
    }))
    expect(runtimeState.shutdownRequests).toEqual([
      expect.objectContaining({
        memberId: "member-a",
        requesterName: "lead",
        requestedAt: expect.any(Number),
      }),
    ])
  })

  test("approves shutdown requests and notifies the lead", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await requestShutdownOfMember(fixture.teamRunId, "member-a", "lead", fixture.config)

    // when
    await approveShutdown(fixture.teamRunId, "member-a", "member-a", fixture.config)

    // then
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    const leadInboxMessages = await readInboxMessages(fixture.teamRunId, "lead", fixture.config)
    const approvedRequest = runtimeState.shutdownRequests.find((shutdownRequest) => shutdownRequest.memberId === "member-a")
    expect(approvedRequest?.approvedAt).toEqual(expect.any(Number))
    expect(runtimeState.members.find((member) => member.name === "member-a")?.status).toBe("shutdown_approved")
    expect(leadInboxMessages.some((message) => (
      message.kind === "shutdown_approved"
      && message.from === "member-a"
      && message.to === "lead"
      && message.body === "member-a"
    ))).toBe(true)
  })

  test("rejects shutdown requests and replies to the original requester", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await requestShutdownOfMember(fixture.teamRunId, "member-a", "lead", fixture.config)

    // when
    await rejectShutdown(fixture.teamRunId, "member-a", "not done yet", fixture.config)

    // then
    const runtimeState = await loadRuntimeState(fixture.teamRunId, fixture.config)
    const leadInboxMessages = await readInboxMessages(fixture.teamRunId, "lead", fixture.config)
    const rejectedRequest = runtimeState.shutdownRequests.find((shutdownRequest) => shutdownRequest.memberId === "member-a")
    expect(rejectedRequest).toEqual(expect.objectContaining({
      rejectedAt: expect.any(Number),
      rejectedReason: "not done yet",
    }))
    expect(leadInboxMessages.some((message) => (
      message.kind === "shutdown_rejected"
      && message.from === "member-a"
      && message.to === "lead"
      && message.body === "not done yet"
    ))).toBe(true)
  })

  test("deletes team runtime resources after all non-lead members are approved", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "shutdown_approved",
    })
    await Promise.all(fixture.worktreePaths.map(async (worktreePath) => {
      await mkdir(worktreePath, { recursive: true })
    }))

    // when
    const result = await deleteTeam(fixture.teamRunId, fixture.config, {} as never)

    // then
    expect(result.removedLayout).toBe(true)
    expect(result.removedWorktrees.sort()).toEqual([...fixture.worktreePaths].sort())
    expect(removeTeamLayoutMock).toHaveBeenCalledWith(fixture.teamRunId, {})
    await Promise.all(fixture.worktreePaths.map(async (worktreePath) => {
      await expect(access(worktreePath)).rejects.toThrow()
    }))
    await expect(access(getRuntimeStateDir(resolveBaseDir(fixture.config), fixture.teamRunId))).rejects.toThrow()
  })

  test("blocks mailbox writes while the team is deleting", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "shutdown_approved",
    })
    await transitionRuntimeState(fixture.teamRunId, (runtimeState) => ({
      ...runtimeState,
      status: "deleting",
    }), fixture.config)

    // when
    const result = sendMessage(
      createTestMessage(),
      fixture.teamRunId,
      fixture.config,
      { isLead: true, activeMembers: ["lead", "member-a", "member-b"] },
    )

    // then
    await expect(result).rejects.toThrow("team is deleting")
  })
})
