/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test"

const runTmuxCommandMock = mock(() => Promise.resolve({ success: true, output: "%1" }))

mock.module("./tmux-runner", () => ({ runTmuxCommand: runTmuxCommandMock }))
mock.module("../../../tools/interactive-bash/tmux-path-resolver", () => ({ getTmuxPath: mock(() => Promise.resolve("tmux")) }))
mock.module("../../../shared", () => ({ log: mock(() => undefined) }))

import { canVisualize, createTeamLayout, removeTeamLayout } from "./layout"

describe("team-layout-tmux", () => {
  beforeEach(() => {
    runTmuxCommandMock.mockClear()
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
      { name: "lead", sessionId: "s1", color: "red" },
      { name: "m2", sessionId: "s2" },
      { name: "m3", sessionId: "s3" },
    ]

    // when
    await createTeamLayout("run-2", members, {} as never)

    // then
    const commands = (runTmuxCommandMock.mock.calls as unknown as Array<[string, Array<string>]>).map((call) => call[1])
    expect(commands.flat()).toContain("new-session")
    expect(commands.flat()).toContain("new-window")
    expect(commands.flat()).toContain("split-window")
    expect(commands.flat()).toContain("select-layout")
    expect(commands.flat()).toContain("select-pane")
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
