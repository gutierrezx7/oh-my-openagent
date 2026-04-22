/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"

import * as sharedModule from "../../../shared"
import * as sharedTmuxModule from "../../../shared/tmux"
import * as tmuxPathResolverModule from "../../../tools/interactive-bash/tmux-path-resolver"
import * as resolveCallerTmuxSessionModule from "./resolve-caller-tmux-session"
import { canVisualize, createTeamLayout, removeTeamLayout } from "./layout"

let nextWindowNumber = 1
let nextPaneNumber = 1
let displaySessionId = "$7"
let displaySuccess = true

function createTmuxCommandResult(output: string, success = true) {
  return {
    success,
    output,
    stdout: output,
    stderr: success ? "" : "error",
    exitCode: success ? 0 : 1,
  }
}

const runTmuxCommandMock = mock((_tmuxPath: string, args: Array<string>, _options?: unknown) => {
  const command = args[0]

  if (command === "display" && args.includes("#{pane_current_command}")) {
    return Promise.resolve(createTmuxCommandResult("fish"))
  }

  if (command === "display") {
    return Promise.resolve(createTmuxCommandResult(displaySessionId, displaySuccess))
  }

  if (command === "new-session") {
    return Promise.resolve(createTmuxCommandResult(`@${nextWindowNumber++}`))
  }

  if (command === "new-window") {
    return Promise.resolve(createTmuxCommandResult(`@${nextWindowNumber++} %${nextPaneNumber++}`))
  }

  if (command === "split-window") {
    return Promise.resolve(createTmuxCommandResult(`%${nextPaneNumber++}`))
  }

  return Promise.resolve(createTmuxCommandResult(""))
})

const isServerRunningMock = mock(async (_serverUrl: string) => true)

async function loadLayoutModule() {
  return { canVisualize, createTeamLayout, removeTeamLayout }
}

type TmuxMgrLike = { getServerUrl: () => string }

const tmuxMgr: TmuxMgrLike = { getServerUrl: () => "http://127.0.0.1:12345" }

function getCommands(): Array<Array<string>> {
  return Array.from(runTmuxCommandMock.mock.calls, (call) => call[1])
}

describe("team-layout-tmux", () => {
  afterEach(() => {
    mock.restore()
  })

  beforeEach(() => {
    runTmuxCommandMock.mockClear()
    isServerRunningMock.mockClear()
    isServerRunningMock.mockImplementation(async () => true)
    nextWindowNumber = 1
    nextPaneNumber = 1
    displaySessionId = "$7"
    displaySuccess = true
    process.env.TMUX = "/tmp/tmux-1"
    process.env.TMUX_PANE = "%42"
    spyOn(tmuxPathResolverModule, "getTmuxPath").mockResolvedValue("tmux")
    spyOn(sharedModule, "log").mockImplementation(() => undefined)
    spyOn(sharedTmuxModule, "isServerRunning").mockImplementation(isServerRunningMock)
    spyOn(sharedTmuxModule, "runTmuxCommand").mockImplementation(runTmuxCommandMock)
    spyOn(resolveCallerTmuxSessionModule, "resolveCallerTmuxSession").mockImplementation(async () => {
      if (!process.env.TMUX_PANE || !displaySuccess || !/^\$[0-9]+$/.test(displaySessionId)) {
        return null
      }

      return { sessionId: displaySessionId }
    })
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
    for (const call of newWindowCalls) {
      const last = call[call.length - 1] ?? ""
      expect(last).not.toContain("opencode")
    }
    for (const call of splitWindowCalls) {
      const last = call[call.length - 1] ?? ""
      expect(last).not.toContain("opencode")
    }
    const sendKeysCalls = commands.filter((args) => args[0] === "send-keys" && args.includes("-l"))
    const sendKeysLiterals = sendKeysCalls.map((args) => args[args.length - 1] ?? "")
    expect(sendKeysLiterals.some((s) => s.includes("--session s-lead") && s.includes("--dir"))).toBe(true)
    expect(sendKeysLiterals.some((s) => s.includes("--session s-m2") && s.includes("--dir"))).toBe(true)
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
    expect(Object.keys(result?.focusPanesByMember ?? {}).sort()).toEqual(["lead", "m2", "m3"])
    expect(Object.keys(result?.gridPanesByMember ?? {}).sort()).toEqual(["lead", "m2", "m3"])
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

  test("#given ownedSession=false, focusWindowId=@10, gridWindowId=@11 #when removeTeamLayout runs #then tmux kill-window is called twice with -t @10 and -t @11 and kill-session is NEVER called", async () => {
    // given
    const { removeTeamLayout } = await loadLayoutModule()

    // when
    await removeTeamLayout("run-cleanup", {
      ownedSession: false,
      targetSessionId: "$caller",
      focusWindowId: "@10",
      gridWindowId: "@11",
    }, tmuxMgr as never)

    // then
    const commands = getCommands()
    expect(commands).toContainEqual(["kill-window", "-t", "@10"])
    expect(commands).toContainEqual(["kill-window", "-t", "@11"])
    expect(commands.some((args) => args[0] === "kill-session")).toBe(false)
  })

  test("#given ownedSession=true, targetSessionId='omo-team-xyz' #when removeTeamLayout runs #then kill-session is called with -t omo-team-xyz (legacy behavior preserved)", async () => {
    // given
    const { removeTeamLayout } = await loadLayoutModule()

    // when
    await removeTeamLayout("run-cleanup", {
      ownedSession: true,
      targetSessionId: "omo-team-xyz",
      focusWindowId: "@10",
      gridWindowId: "@11",
    }, tmuxMgr as never)

    // then
    const commands = getCommands()
    expect(commands).toContainEqual(["kill-session", "-t", "omo-team-xyz"])
  })

  test("#given ownedSession=false and the first kill-window fails #when removeTeamLayout runs #then the second kill-window still fires", async () => {
    // given
    const { removeTeamLayout } = await loadLayoutModule()
    let killWindowCallCount = 0
    runTmuxCommandMock.mockImplementation((_tmuxPath: string, args: Array<string>, _options?: unknown) => {
      if (args[0] === "kill-window") {
        killWindowCallCount += 1
        return Promise.resolve(createTmuxCommandResult("", killWindowCallCount > 1))
      }

      const command = args[0]
      if (command === "display") {
        return Promise.resolve(createTmuxCommandResult(displaySessionId, displaySuccess))
      }
      if (command === "new-session") {
        return Promise.resolve(createTmuxCommandResult(`@${nextWindowNumber++}`))
      }
      if (command === "new-window") {
        return Promise.resolve(createTmuxCommandResult(`@${nextWindowNumber++} %${nextPaneNumber++}`))
      }
      if (command === "split-window") {
        return Promise.resolve(createTmuxCommandResult(`%${nextPaneNumber++}`))
      }

      return Promise.resolve(createTmuxCommandResult(""))
    })

    // when
    await removeTeamLayout("run-cleanup", {
      ownedSession: false,
      targetSessionId: "$caller",
      focusWindowId: "@10",
      gridWindowId: "@11",
    }, tmuxMgr as never)

    // then
    const commands = getCommands().filter((args) => args[0] === "kill-window")
    expect(commands).toEqual([
      ["kill-window", "-t", "@10"],
      ["kill-window", "-t", "@11"],
    ])
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

  describe("createTeamLayout - caller-session topology", () => {
		test("#given caller inside tmux with TMUX_PANE=%42 resolving to session $7 #when createTeamLayout runs #then both new-window calls target -t $7 and new-session is never invoked", async () => {
			// given
			const { createTeamLayout } = await loadLayoutModule()
			const members = [
				{ name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" },
				{ name: "m2", sessionId: "s-m2", worktreePath: "/tmp/m2" },
			]

			// when
			await createTeamLayout("run-caller-session", members, tmuxMgr as never)

			// then
			const commands = getCommands()
			expect(commands.some((args) => args[0] === "new-session")).toBe(false)
			const newWindowTargets = commands
				.filter((args) => args[0] === "new-window")
				.map((args) => {
					const targetIndex = args.indexOf("-t")
					return targetIndex >= 0 ? args[targetIndex + 1] : undefined
				})
			expect(newWindowTargets).toEqual(["$7", "$7"])
		})

		test("#given caller session resolved #when createTeamLayout runs #then returned ownedSession is false and targetSessionId equals the resolved id", async () => {
			// given
			const { createTeamLayout } = await loadLayoutModule()
			const members = [{ name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" }]

			// when
			const result = await createTeamLayout("run-owned-false", members, tmuxMgr as never)

			// then
			expect(result).not.toBeNull()
			expect(result?.ownedSession).toBe(false)
			expect(result?.targetSessionId).toBe("$7")
		})

		test("#given TMUX_PANE cannot be resolved (display returns empty) #when createTeamLayout runs #then it falls back to legacy detached session, new-session IS called, ownedSession is true, targetSessionId equals omo-team-<teamRunId>", async () => {
			// given
			displaySessionId = ""
			const { createTeamLayout } = await loadLayoutModule()
			const teamRunId = "run-fallback"
			const members = [{ name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" }]

			// when
			const result = await createTeamLayout(teamRunId, members, tmuxMgr as never)

			// then
			const commands = getCommands()
			expect(commands.some((args) => args[0] === "new-session")).toBe(true)
			expect(result).not.toBeNull()
			expect(result?.ownedSession).toBe(true)
			expect(result?.targetSessionId).toBe("omo-team-run-fallback")
		})

		test("#given 3 members #when createTeamLayout runs #then focusPanesByMember and gridPanesByMember each contain exactly 3 distinct pane ids keyed by member name", async () => {
			// given
			const { createTeamLayout } = await loadLayoutModule()
			const members = [
				{ name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" },
				{ name: "m2", sessionId: "s-m2", worktreePath: "/tmp/m2" },
				{ name: "m3", sessionId: "s-m3", worktreePath: "/tmp/m3" },
			]

			// when
			const result = await createTeamLayout("run-pane-maps", members, tmuxMgr as never)

			// then
			expect(result).not.toBeNull()
			expect(Object.keys(result?.focusPanesByMember ?? {}).sort()).toEqual(["lead", "m2", "m3"])
			expect(Object.keys(result?.gridPanesByMember ?? {}).sort()).toEqual(["lead", "m2", "m3"])
			expect(new Set(Object.values(result?.focusPanesByMember ?? {})).size).toBe(3)
			expect(new Set(Object.values(result?.gridPanesByMember ?? {})).size).toBe(3)
		})

		test("#given lead is the sole member #when createTeamLayout runs #then no split-window calls are made and both windows still reach select-layout", async () => {
			// given
			const { createTeamLayout } = await loadLayoutModule()
			const members = [{ name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" }]

			// when
			await createTeamLayout("run-lead-only", members, tmuxMgr as never)

			// then
			const commands = getCommands()
			expect(commands.some((args) => args[0] === "split-window")).toBe(false)
			const selectLayoutArgs = commands.filter((args) => args[0] === "select-layout").map((args) => args[args.length - 1])
			expect(selectLayoutArgs).toEqual(["main-vertical", "tiled"])
		})

		test("#given windows created #when createTeamLayout runs #then select-layout is invoked with ['main-vertical','tiled'] in that order", async () => {
			// given
			const { createTeamLayout } = await loadLayoutModule()
			const members = [
				{ name: "lead", sessionId: "s-lead", worktreePath: "/tmp/lead" },
				{ name: "m2", sessionId: "s-m2", worktreePath: "/tmp/m2" },
			]

			// when
			await createTeamLayout("run-layout-order", members, tmuxMgr as never)

			// then
			const commands = getCommands()
			const selectLayoutArgs = commands.filter((args) => args[0] === "select-layout").map((args) => args[args.length - 1])
			expect(selectLayoutArgs).toEqual(["main-vertical", "tiled"])
		})
	})
})
