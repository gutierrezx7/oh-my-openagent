import { beforeEach, describe, expect, it, mock } from "bun:test"

import type { TmuxConfig } from "../../../config/schema"
import type { TmuxCommandResult } from "../runner"

const sessionSpawnSpecifier = import.meta.resolve("./session-spawn")
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
	output: "",
	stdout: "",
	stderr: "",
	exitCode: 0,
}))
const isInsideTmuxMock = mock((): boolean => true)
const isServerRunningMock = mock(async (): Promise<boolean> => true)
const getTmuxPathMock = mock(async (): Promise<string | undefined> => "sh")
const logMock = mock(() => undefined)

async function loadSpawnTmuxSession(): Promise<typeof import("./session-spawn").spawnTmuxSession> {
	const module = await import(`${sessionSpawnSpecifier}?test=${crypto.randomUUID()}`)
	return module.spawnTmuxSession
}

function registerModuleMocks(): void {
	mock.module(environmentSpecifier, () => ({ isInsideTmux: isInsideTmuxMock }))
	mock.module(loggerSpecifier, () => ({ log: logMock }))
	mock.module(runnerSpecifier, () => ({ runTmuxCommand: runTmuxCommandMock }))
	mock.module(serverHealthSpecifier, () => ({ isServerRunning: isServerRunningMock }))
	mock.module(tmuxPathResolverSpecifier, () => ({ getTmuxPath: getTmuxPathMock }))
}

describe("spawnTmuxSession runner integration", () => {
	beforeEach(() => {
		registerModuleMocks()
		runTmuxCommandMock.mockClear()
		isInsideTmuxMock.mockClear()
		isServerRunningMock.mockClear()
		getTmuxPathMock.mockClear()
		logMock.mockClear()

		runTmuxCommandMock
			.mockResolvedValueOnce({ success: true, output: "120,40", stdout: "120,40", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ success: false, output: "", stdout: "", stderr: "", exitCode: 1 })
			.mockResolvedValueOnce({ success: true, output: "%42", stdout: "%42", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ success: true, output: "", stdout: "", stderr: "", exitCode: 0 })
		isInsideTmuxMock.mockReturnValue(true)
		isServerRunningMock.mockResolvedValue(true)
		getTmuxPathMock.mockResolvedValue("sh")
	})

	it("#given source pane available #when spawnTmuxSession called #then delegates display, has-session, new-session, and select-pane to shared runner", async () => {
		// given
		const spawnTmuxSession = await loadSpawnTmuxSession()

		// when
		const result = await spawnTmuxSession("session-1", "worker", enabledTmuxConfig, "http://127.0.0.1:1234", "%0")

		// then
		expect(result).toEqual({ success: true, paneId: "%42" })
		expect(runTmuxCommandMock).toHaveBeenNthCalledWith(1,
			expect.any(String),
			["display", "-p", "-t", "%0", "#{window_width},#{window_height}"],
		)
		expect(runTmuxCommandMock).toHaveBeenNthCalledWith(2, expect.any(String), ["has-session", "-t", expect.stringContaining("omo-agents-")])
		expect(runTmuxCommandMock).toHaveBeenNthCalledWith(3,
			expect.any(String),
			expect.arrayContaining(["new-session", "-d", "-s", expect.stringContaining("omo-agents-")]),
		)
		expect(runTmuxCommandMock).toHaveBeenNthCalledWith(4,
			expect.any(String),
			["select-pane", "-t", "%42", "-T", "omo-subagent-worker"],
		)
	})
})
