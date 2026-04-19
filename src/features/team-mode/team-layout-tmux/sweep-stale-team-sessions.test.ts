/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test"

import {
	sweepStaleTeamSessionsWith,
	type TeamSweepDeps,
} from "./sweep-stale-team-sessions"

type LoggedMessage = {
	message: string
	meta?: Record<string, unknown>
}

type SweepFixture = {
	deps: TeamSweepDeps
	killedSessionNames: string[]
	loggedMessages: LoggedMessage[]
	killSessionMock: ReturnType<typeof mock>
	listCandidatesMock: ReturnType<typeof mock>
}

function createFixture(candidateSessions: string[]): SweepFixture {
	const killedSessionNames: string[] = []
	const loggedMessages: LoggedMessage[] = []

	const listCandidatesMock = mock(async (): Promise<string[]> => [...candidateSessions])
	const killSessionMock = mock(async (sessionName: string): Promise<void> => {
		killedSessionNames.push(sessionName)
	})

	const deps: TeamSweepDeps = {
		listCandidates: listCandidatesMock,
		killSession: killSessionMock,
		log: (message, meta) => {
			loggedMessages.push({ message, meta })
		},
	}

	return {
		deps,
		killedSessionNames,
		loggedMessages,
		killSessionMock,
		listCandidatesMock,
	}
}

describe("sweepStaleTeamSessionsWith", () => {
	it("#given candidates with mix of active and stale #when sweep #then kills only sessions whose runId is not in active set", async () => {
		// given
		const fixture = createFixture(["omo-team-A", "omo-team-B", "omo-team-C", "main", "omo-agents-123"])
		const activeTeamRunIds = new Set(["A"])

		// when
		const result = await sweepStaleTeamSessionsWith(activeTeamRunIds, fixture.deps)

		// then
		expect(fixture.killSessionMock).toHaveBeenCalledTimes(2)
		expect(fixture.killedSessionNames).toEqual(["omo-team-B", "omo-team-C"])
		expect(result).toEqual(["omo-team-B", "omo-team-C"])
	})

	it("#given all candidates active #when sweep #then kills none", async () => {
		// given
		const fixture = createFixture(["omo-team-A", "omo-team-B"])
		const activeTeamRunIds = new Set(["A", "B"])

		// when
		const result = await sweepStaleTeamSessionsWith(activeTeamRunIds, fixture.deps)

		// then
		expect(fixture.killSessionMock).toHaveBeenCalledTimes(0)
		expect(result).toEqual([])
	})

	it("#given listCandidates throws #when sweep #then returns empty array and logs", async () => {
		// given
		const fixture = createFixture([])
		const activeTeamRunIds = new Set<string>()
		fixture.listCandidatesMock.mockImplementation(async (): Promise<string[]> => {
			throw new Error("list failed")
		})

		// when
		const result = await sweepStaleTeamSessionsWith(activeTeamRunIds, fixture.deps)

		// then
		expect(result).toEqual([])
		expect(fixture.loggedMessages).toHaveLength(1)
		expect(fixture.loggedMessages[0]?.message).toContain("failed to list")
	})

	it("#given killSession throws for one #when sweep #then continues and returns only successful kills", async () => {
		// given
		const fixture = createFixture(["omo-team-A", "omo-team-B", "omo-team-C"])
		const activeTeamRunIds = new Set<string>()
		fixture.killSessionMock.mockImplementation(async (sessionName: string): Promise<void> => {
			if (sessionName === "omo-team-B") {
				throw new Error("kill failed")
			}

			fixture.killedSessionNames.push(sessionName)
		})

		// when
		const result = await sweepStaleTeamSessionsWith(activeTeamRunIds, fixture.deps)

		// then
		expect(fixture.killSessionMock).toHaveBeenCalledTimes(3)
		expect(fixture.killedSessionNames).toEqual(["omo-team-A", "omo-team-C"])
		expect(fixture.loggedMessages).toHaveLength(1)
		expect(result).toEqual(["omo-team-A", "omo-team-C"])
	})

	it("#given candidate name is 'omo-team-' with empty suffix #when sweep #then skipped", async () => {
		// given
		const fixture = createFixture(["omo-team-", "omo-team-A"])
		const activeTeamRunIds = new Set<string>()

		// when
		const result = await sweepStaleTeamSessionsWith(activeTeamRunIds, fixture.deps)

		// then
		expect(fixture.killedSessionNames).toEqual(["omo-team-A"])
		expect(result).toEqual(["omo-team-A"])
	})
})
