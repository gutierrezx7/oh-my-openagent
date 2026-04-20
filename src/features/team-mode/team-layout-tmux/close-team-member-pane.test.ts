/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test"

const closeTeamMemberPaneSpecifier = import.meta.resolve("./close-team-member-pane")
const sharedSpecifier = import.meta.resolve("../../../shared")
const sharedTmuxSpecifier = import.meta.resolve("../../../shared/tmux")
const tmuxPathResolverSpecifier = import.meta.resolve("../../../tools/interactive-bash/tmux-path-resolver")

const closeTmuxPaneMock = mock(async (): Promise<boolean> => true)
const getTmuxPathMock = mock(async (): Promise<string | undefined> => "sh")
const logMock = mock(() => undefined)

async function loadCloseTeamMemberPane(): Promise<typeof import("./close-team-member-pane").closeTeamMemberPane> {
	const module = await import(`${closeTeamMemberPaneSpecifier}?test=${crypto.randomUUID()}`)
	return module.closeTeamMemberPane
}

function registerModuleMocks(): void {
	mock.module(sharedSpecifier, () => ({ log: logMock }))
	mock.module(sharedTmuxSpecifier, () => ({ closeTmuxPane: closeTmuxPaneMock }))
	mock.module(tmuxPathResolverSpecifier, () => ({ getTmuxPath: getTmuxPathMock }))
}

describe("closeTeamMemberPane", () => {
	beforeEach(() => {
		registerModuleMocks()
		closeTmuxPaneMock.mockClear()
		getTmuxPathMock.mockClear()
		logMock.mockClear()

		closeTmuxPaneMock.mockResolvedValue(true)
		getTmuxPathMock.mockResolvedValue("sh")
	})

	it("#given team pane id #when closeTeamMemberPane called #then delegates to shared closeTmuxPane", async () => {
		// given
		const closeTeamMemberPane = await loadCloseTeamMemberPane()

		// when
		const result = await closeTeamMemberPane("%42")

		// then
		expect(result).toBe(true)
		expect(closeTmuxPaneMock).toHaveBeenCalledTimes(1)
		expect(closeTmuxPaneMock).toHaveBeenCalledWith("%42")
	})

	it("#given shared close returns false #when closeTeamMemberPane called #then returns false", async () => {
		// given
		const closeTeamMemberPane = await loadCloseTeamMemberPane()
		closeTmuxPaneMock.mockResolvedValue(false)

		// when
		const result = await closeTeamMemberPane("%42")

		// then
		expect(result).toBe(false)
	})

	it("#given empty pane id #when closeTeamMemberPane called #then returns false without delegation", async () => {
		// given
		const closeTeamMemberPane = await loadCloseTeamMemberPane()

		// when
		const result = await closeTeamMemberPane("")

		// then
		expect(result).toBe(false)
		expect(closeTmuxPaneMock).not.toHaveBeenCalled()
	})
})
