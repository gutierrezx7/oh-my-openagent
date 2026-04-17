/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test"

let nextWindowNumber = 1
let nextPaneNumber = 1

const ensureTeamMemberFifoMock = mock(async (teamRunId: string, memberName: string) => `/tmp/omo-team/${teamRunId}/${memberName}.fifo`)

const runTmuxCommandMock = mock((_tmuxPath: string, args: Array<string>) => {
  const command = args[0]

  if (command === "new-session") {
    return Promise.resolve({ success: true, output: `@${nextWindowNumber++}` })
  }

  if (command === "new-window") {
    return Promise.resolve({ success: true, output: `@${nextWindowNumber++} %${nextPaneNumber++}` })
  }

  if (command === "split-window") {
    return Promise.resolve({ success: true, output: `%${nextPaneNumber++}` })
  }

  return Promise.resolve({ success: true, output: "" })
})

mock.module("./tmux-runner", () => ({ runTmuxCommand: runTmuxCommandMock }))
mock.module("./ensure-team-member-fifo", () => ({ ensureTeamMemberFifo: ensureTeamMemberFifoMock }))
mock.module("../../../tools/interactive-bash/tmux-path-resolver", () => ({ getTmuxPath: mock(() => Promise.resolve("tmux")) }))
mock.module("../../../shared", () => ({ log: mock(() => undefined) }))

import { canVisualize, createTeamLayout, removeTeamLayout } from "./layout"

describe("team-layout-tmux", () => {
  beforeEach(() => {
    runTmuxCommandMock.mockClear()
    ensureTeamMemberFifoMock.mockClear()
    nextWindowNumber = 1
    nextPaneNumber = 1
    process.env.TMUX = "/tmp/tmux-1"
  })

  test("returns null and makes no tmux calls when visualization unavailable", async () => {
    // given
    delete process.env.TMUX

    // when
    const result = await createTeamLayout("run-1", [], {} as never)

    // then
    expect(canVisualize()).toBe(false)
    expect(result).toBeNull()
    expect(runTmuxCommandMock).toHaveBeenCalledTimes(0)
  })

  test("creates focus and grid windows", async () => {
    // given
    const members = [
      { name: "lead", sessionId: "s1", color: "red", worktreePath: "/tmp/lead" },
      { name: "m2", sessionId: "s2", worktreePath: "/tmp/m2" },
      { name: "m3", sessionId: "s3" },
    ]

    // when
    const result = await createTeamLayout("run-2", members, {} as never)

    // then
    const commands = (runTmuxCommandMock.mock.calls as unknown as Array<[string, Array<string>]>).map((call) => call[1])
    expect(commands.flat()).toContain("new-session")
    expect(commands.flat()).toContain("new-window")
    expect(commands.flat()).toContain("split-window")
    expect(commands.flat()).toContain("select-layout")
    expect(commands.flat()).toContain("select-pane")
    expect(commands.flat()).toContain("send-keys")
    expect(commands).toContainEqual(["new-window", "-d", "-P", "-F", "#{window_id} #{pane_id}", "-t", "omo-team-run-2", "-n", "focus", "-c", "/tmp/lead"])
    expect(commands).toContainEqual(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "@2", "-c", "/tmp/m2"])
expect(commands).toContainEqual(["send-keys", "-t", "%1", "tail -n +1 -f '/tmp/omo-team/run-2/lead.fifo'", "Enter"])
expect(commands).toContainEqual(["send-keys", "-t", "%3", "tail -n +1 -f '/tmp/omo-team/run-2/m3.fifo'", "Enter"])
    expect(ensureTeamMemberFifoMock).toHaveBeenCalledTimes(3)
    expect(result?.fifoByMember).toEqual({
      lead: "/tmp/omo-team/run-2/lead.fifo",
      m2: "/tmp/omo-team/run-2/m2.fifo",
      m3: "/tmp/omo-team/run-2/m3.fifo",
    })
  })

  test("returns null when tmux command fails", async () => {
    // given
    runTmuxCommandMock.mockImplementationOnce(() => Promise.resolve({ success: false, output: "" }))

    // when
    const result = await createTeamLayout("run-3", [{ name: "lead", sessionId: "s1" }], {} as never)

    // then
    expect(result).toBeNull()
  })

  test("cleans up the tmux session", async () => {
    // given
    // when
    await removeTeamLayout("run-4", {} as never)

    // then
    const commands = (runTmuxCommandMock.mock.calls as unknown as Array<[string, Array<string>]>).map((call) => call[1]).flat()
    expect(commands).toContain("kill-session")
  })
})
