import { beforeEach, describe, expect, it, mock } from "bun:test"

import type { TmuxConfig } from "../../../config/schema"
import type { TmuxCommandResult } from "../runner"

const paneReplaceSpecifier = import.meta.resolve("./pane-replace")
const environmentSpecifier = import.meta.resolve("./environment")
const loggerSpecifier = import.meta.resolve("../../logger")
const runnerSpecifier = import.meta.resolve("../runner")
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
const getTmuxPathMock = mock(async (): Promise<string | undefined> => "sh")
const logMock = mock(() => undefined)

async function loadReplaceTmuxPane(): Promise<typeof import("./pane-replace").replaceTmuxPane> {
	const module = await import(`${paneReplaceSpecifier}?test=${crypto.randomUUID()}`)
	return module.replaceTmuxPane
}

function registerModuleMocks(): void {
	mock.module(environmentSpecifier, () => ({ isInsideTmux: isInsideTmuxMock }))
	mock.module(loggerSpecifier, () => ({ log: logMock }))
	mock.module(runnerSpecifier, () => ({ runTmuxCommand: runTmuxCommandMock }))
	mock.module(tmuxPathResolverSpecifier, () => ({ getTmuxPath: getTmuxPathMock }))
}

describe("replaceTmuxPane runner integration", () => {
	beforeEach(() => {
		registerModuleMocks()
		runTmuxCommandMock.mockClear()
		isInsideTmuxMock.mockClear()
		getTmuxPathMock.mockClear()
		logMock.mockClear()

		runTmuxCommandMock
			.mockResolvedValueOnce({ success: true, output: "", stdout: "", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ success: true, output: "", stdout: "", stderr: "", exitCode: 0 })
			.mockResolvedValueOnce({ success: true, output: "", stdout: "", stderr: "", exitCode: 0 })
		isInsideTmuxMock.mockReturnValue(true)
		getTmuxPathMock.mockResolvedValue("sh")
	})

	it("#given existing pane #when replaceTmuxPane called #then delegates send-keys, respawn-pane, and select-pane to shared runner", async () => {
		// given
		const replaceTmuxPane = await loadReplaceTmuxPane()

		// when
		const result = await replaceTmuxPane("%42", "session-1", "worker", enabledTmuxConfig, "http://127.0.0.1:1234")

		// then
		expect(result).toEqual({ success: true, paneId: "%42" })
		expect(runTmuxCommandMock.mock.calls).toEqual([
			[expect.any(String), ["send-keys", "-t", "%42", "C-c"]],
			[expect.any(String), expect.arrayContaining(["respawn-pane", "-k", "-t", "%42"])],
			[expect.any(String), ["select-pane", "-t", "%42", "-T", "omo-subagent-worker"]],
		])
	})
})
