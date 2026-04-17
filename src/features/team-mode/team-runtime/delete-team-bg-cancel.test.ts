/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test"
import { rm } from "node:fs/promises"

import type { BackgroundManager } from "../../background-agent/manager"
import { createFixture, updateMemberStatuses } from "./shutdown-test-fixtures"

const { deleteTeam } = await import("./delete-team")

describe("deleteTeam — cancels background tasks by leadSessionId", () => {
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(async (directoryPath) => {
      await rm(directoryPath, { recursive: true, force: true })
    }))
  })

  test("uses leadSessionId (not teamRunId) as getTasksByParentSession key", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "shutdown_approved",
    })

    const getTasksByParentSessionMock = mock((sessionID: string) => {
      if (sessionID !== "lead-session") return []
      return [
        { id: "task-a", sessionID: "session-a" },
        { id: "task-b", sessionID: "session-b" },
      ]
    })
    const cancelTaskMock = mock(async () => true)
    const bgMgr = {
      getTasksByParentSession: getTasksByParentSessionMock,
      cancelTask: cancelTaskMock,
    } as unknown as BackgroundManager

    // when
    await deleteTeam(fixture.teamRunId, fixture.config, undefined, bgMgr)

    // then
    expect(getTasksByParentSessionMock).toHaveBeenCalledTimes(1)
    expect(getTasksByParentSessionMock).toHaveBeenCalledWith("lead-session")
    expect(cancelTaskMock).toHaveBeenCalledTimes(2)
    const firstCall = cancelTaskMock.mock.calls[0]
    const secondCall = cancelTaskMock.mock.calls[1]
    expect(firstCall?.[0]).toBe("task-a")
    expect(secondCall?.[0]).toBe("task-b")
  })

  test("skips cancellation when runtimeState.leadSessionId is absent", async () => {
    // given
    const fixture = await createFixture()
    temporaryDirectories.push(fixture.baseDir)
    await updateMemberStatuses(fixture.teamRunId, fixture.config, {
      "member-a": "shutdown_approved",
      "member-b": "shutdown_approved",
    })

    const getTasksByParentSessionMock = mock(() => [
      { id: "task-a", sessionID: "session-a" },
    ])
    const cancelTaskMock = mock(async () => true)
    const bgMgr = {
      getTasksByParentSession: getTasksByParentSessionMock,
      cancelTask: cancelTaskMock,
    } as unknown as BackgroundManager

    // when
    await deleteTeam(fixture.teamRunId, fixture.config, undefined, bgMgr)

    // then
    expect(getTasksByParentSessionMock).toHaveBeenCalled()
    const parentSessionArg = getTasksByParentSessionMock.mock.calls[0]?.[0]
    expect(parentSessionArg).not.toBe(fixture.teamRunId)
    expect(parentSessionArg).toBe("lead-session")
  })
})
