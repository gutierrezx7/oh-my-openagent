import { beforeEach, describe, expect, it, mock } from "bun:test"

import type { TmuxConfig } from "../../../config/schema"
import type { TmuxCommandResult } from "../runner"

const windowSpawnSpecifier = import.meta.resolve("./window-spawn")
const environmentSpecifier = import.meta.resolve("./environment")
const loggerSpecifier = import.meta.resolve("../../logger")
const runnerSpecifier = import.meta.resolve("../runner")
const serverHealthSpecifier = import.meta.resolve("./server-health")
const tmuxPathResolverSpecifier = import.meta.resolve("../../../tools/interactive-bash/tmux-path-resolver")

const enabledTmuxConfig = {
	enabled: true,
	layout: "main-vertical",
	main_pane_size: 60,
	main_pane_min_width: 120,
	agent_pane_min_width: 40,
	isolation: "inline",
} satisfies TmuxConfig

const runTmuxCommandMock = mock(async (): Promise<TmuxCommandResult> => ({
	success: true,
	output: "%42",
	stdout: "%42",
	stderr: "",
	exitCode: 0,
}))
const isInsideTmuxMock = mock((): boolean => true)
const isServerRunningMock = mock(async (): Promise<boolean> => true)
const getTmuxPathMock = mock(async (): Promise<string | undefined> => "sh")
const logMock = mock(() => undefined)

async function loadSpawnTmuxWindow(): Promise<typeof import("./window-spawn").spawnTmuxWindow> {
	const module = await import(`${windowSpawnSpecifier}?test=${crypto.randomUUID()}`)
	return module.spawnTmuxWindow
}

function registerModuleMocks(): void {
	mock.module(environmentSpecifier, () => ({ isInsideTmux: isInsideTmuxMock }))
	mock.module(loggerSpecifier, () => ({ log: logMock }))
	mock.module(runnerSpecifier, () => ({ runTmuxCommand: runTmuxCommandMock }))
	mock.module(serverHealthSpecifier, () => ({ isServerRunning: isServerRunningMock }))
	mock.module(tmuxPathResolverSpecifier, () => ({ getTmuxPath: getTmuxPathMock }))
}

describe("spawnTmuxWindow runner integration", () => {
	beforeEach(() => {
		registerModuleMocks()
		runTmuxCommandMock.mockClear()
		isInsideTmuxMock.mockClear()
		isServerRunningMock.mockClear()
		getTmuxPathMock.mockClear()
		logMock.mockClear()

		runTmuxCommandMock
			.mockResolvedValueOnce({ success: true, output: "%42", stdout: "%42", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ success: true, output: "", stdout: "", stderr: "", exitCode: 0 })
		isInsideTmuxMock.mockReturnValue(true)
		isServerRunningMock.mockResolvedValue(true)
		getTmuxPathMock.mockResolvedValue("sh")
	})

	it("#given healthy tmux environment #when spawnTmuxWindow called #then delegates new-window and select-pane to shared runner", async () => {
		// given
		const spawnTmuxWindow = await loadSpawnTmuxWindow()

		// when
		const result = await spawnTmuxWindow("session-1", "worker", enabledTmuxConfig, "http://127.0.0.1:1234")

		// then
		expect(result).toEqual({ success: true, paneId: "%42" })
		expect(runTmuxCommandMock.mock.calls[0]).toEqual([
			expect.any(String),
			expect.arrayContaining(["new-window", "-d", "-n", "omo-agents", "-P", "-F", "#{pane_id}"]),
		])
		expect(runTmuxCommandMock.mock.calls[1]).toEqual([
			expect.any(String),
			["select-pane", "-t", "%42", "-T", "omo-subagent-worker"],
		])
	})
})
