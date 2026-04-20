/// <reference types="bun-types" />

import { beforeEach, describe, expect, mock, test } from "bun:test"

let nextWindowNumber = 1
let nextPaneNumber = 1

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

const isServerRunningMock = mock(async (_serverUrl: string) => true)

function registerMocks(): void {
	mock.module("../../../tools/interactive-bash/tmux-path-resolver", () => ({ getTmuxPath: mock(() => Promise.resolve("tmux")) }))
	mock.module("../../../shared", () => ({ log: mock(() => undefined) }))
	mock.module("../../../shared/tmux", () => ({
		isServerRunning: isServerRunningMock,
		runTmuxCommand: runTmuxCommandMock,
	}))
}

async function loadLayoutModule() {
  registerMocks()
  return import(new URL(`./layout.ts?test=${Date.now()}-${Math.random()}`, import.meta.url).href)
}

type TmuxMgrLike = { getServerUrl: () => string }

const tmuxMgr: TmuxMgrLike = { getServerUrl: () => "http://127.0.0.1:12345" }

function getCommands(): Array<Array<string>> {
  return (runTmuxCommandMock.mock.calls as unknown as Array<[string, Array<string>]>).map((call) => call[1])
}

describe("team-layout-tmux", () => {
  beforeEach(() => {
    registerMocks()
    runTmuxCommandMock.mockClear()
    isServerRunningMock.mockClear()
    isServerRunningMock.mockImplementation(async () => true)
    nextWindowNumber = 1
    nextPaneNumber = 1
    process.env.TMUX = "/tmp/tmux-1"
  })

  test("returns null and makes no tmux calls when visualization unavailable", async () => {
    // given
    delete process.env.TMUX
    const { canVisualize, createTeamLayout } = await loadLayoutModule()

    // when
    const result = await createTeamLayout("run-1", [], tmuxMgr as never)

    // then
    expect(canVisualize()).toBe(false)
    expect(result).toBeNull()
    expect(runTmuxCommandMock).toHaveBeenCalledTimes(0)
  })

  test("returns null when server health check fails", async () => {
    // given
    isServerRunningMock.mockImplementation(async () => false)
    const { createTeamLayout } = await loadLayoutModule()

    // when
    const result = await createTeamLayout(
      "run-health",
      [{ name: "lead", sessionId: "s1", worktreePath: "/tmp/lead" }],
      tmuxMgr as never,
    )

    // then
    expect(result).toBeNull()
    expect(runTmuxCommandMock).toHaveBeenCalledTimes(0)
  })

  test("spawns each pane with opencode attach as the initial command", async () => {
    // given
    const { createTeamLayout } = await loadLayoutModule()
    const members = [
      { name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" },
      { name: "m2", sessionId: "s-m2", worktreePath: "/tmp/m2" },
    ]

    // when
    await createTeamLayout("run-attach", members, tmuxMgr as never)

    // then
    const commands = getCommands()
    const newWindowCalls = commands.filter((args) => args[0] === "new-window")
    const splitWindowCalls = commands.filter((args) => args[0] === "split-window")
    expect(newWindowCalls.length).toBeGreaterThan(0)
    expect(splitWindowCalls.length).toBeGreaterThan(0)
    const leadSnippet = "opencode attach 'http://127.0.0.1:12345' --session 's-lead' --dir '/tmp/lead'"
    const m2Snippet = "opencode attach 'http://127.0.0.1:12345' --session 's-m2' --dir '/tmp/m2'"
    for (const call of newWindowCalls) {
      const last = call[call.length - 1] ?? ""
      expect(last).toContain(leadSnippet)
    }
    const splitSnippets = splitWindowCalls.map((call) => call[call.length - 1] ?? "")
    expect(splitSnippets.some((snippet) => snippet.includes(m2Snippet))).toBe(true)
  })

  test("creates focus (main-vertical) and grid (tiled) windows", async () => {
    // given
    const { createTeamLayout } = await loadLayoutModule()
    const members = [
      { name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" },
      { name: "m2", sessionId: "s-m2", worktreePath: "/tmp/m2" },
      { name: "m3", sessionId: "s-m3", worktreePath: "/tmp/m3" },
    ]

    // when
    const result = await createTeamLayout("run-layout", members, tmuxMgr as never)

    // then
    const commands = getCommands()
    const selectLayoutArgs = commands.filter((args) => args[0] === "select-layout").map((args) => args[args.length - 1])
    expect(selectLayoutArgs).toEqual(["main-vertical", "tiled"])
    expect(result).not.toBeNull()
    expect(Object.keys(result?.panesByMember ?? {}).sort()).toEqual(["lead", "m2", "m3"])
  })

  test("sets pane title for each member", async () => {
    // given
    const { createTeamLayout } = await loadLayoutModule()
    const members = [
      { name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" },
      { name: "m2", sessionId: "s-m2", worktreePath: "/tmp/m2" },
    ]

    // when
    await createTeamLayout("run-title", members, tmuxMgr as never)

    // then
    const commands = getCommands()
    const titleSetters = commands
      .filter((args) => args[0] === "select-pane" && args.includes("-T"))
      .map((args) => args[args.length - 1])
    const counts: Record<string, number> = {}
    for (const name of titleSetters) counts[name] = (counts[name] ?? 0) + 1
    expect(counts["lead"]).toBe(2)
    expect(counts["m2"]).toBe(2)
  })

  test("cleans up the tmux session on removeTeamLayout", async () => {
    // given
    const { removeTeamLayout } = await loadLayoutModule()
    runTmuxCommandMock.mockImplementationOnce(() => Promise.resolve({ success: false, output: "no such session" }))

    // when
    await removeTeamLayout("run-cleanup", tmuxMgr as never)

    // then
    const commands = getCommands()
    expect(commands).toContainEqual(["kill-session", "-t", "omo-team-run-cleanup"])
  })

  test("skips all panes when lead member missing", async () => {
    // given
    const { createTeamLayout } = await loadLayoutModule()
    const members: Array<{ name: string; sessionId: string }> = []

    // when
    const result = await createTeamLayout("run-empty", members, tmuxMgr as never)

    // then
    expect(result).toBeNull()
    const commands = getCommands()
    expect(commands.some((args) => args[0] === "new-window")).toBe(false)
  })
})
