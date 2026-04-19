export const TEAM_SESSION_PATTERN = /^omo-team-(.+)$/

export type TeamSweepDeps = {
	listCandidates: () => Promise<string[]>
	killSession: (name: string) => Promise<void>
	log: (message: string, meta?: Record<string, unknown>) => void
}

type TeamSweepRuntimeDeps = {
	getTmuxPath: () => Promise<string | null>
	log: TeamSweepDeps["log"]
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}

	return String(error)
}

async function listTeamSessionsViaTmux(tmuxPath: string): Promise<string[]> {
	const { runTmuxCommand } = await import("./tmux-runner")
	const result = await runTmuxCommand(tmuxPath, ["list-sessions", "-F", "#{session_name}"])

	if (!result.success) {
		return []
	}

	return result.output
		.split("\n")
		.map((line) => line.trim())
		.filter((sessionName) => sessionName.length > 0)
}

async function killTeamSessionViaTmux(tmuxPath: string, sessionName: string): Promise<void> {
	const { runTmuxCommand } = await import("./tmux-runner")
	const result = await runTmuxCommand(tmuxPath, ["kill-session", "-t", sessionName])

	if (!result.success) {
		throw new Error(`Failed to kill tmux session: ${sessionName}`)
	}
}

async function buildRuntimeDeps(): Promise<TeamSweepRuntimeDeps> {
	const [{ log }, { getTmuxPath }] = await Promise.all([
		import("../../../shared"),
		import("../../../tools/interactive-bash/tmux-path-resolver"),
	])

	return {
		getTmuxPath,
		log,
	}
}

export async function sweepStaleTeamSessionsWith(
	activeTeamRunIds: ReadonlySet<string>,
	deps: TeamSweepDeps,
): Promise<string[]> {
	let candidateSessions: string[]

	try {
		candidateSessions = await deps.listCandidates()
	} catch (error) {
		deps.log("[sweepStaleTeamSessionsWith] failed to list candidate sessions", {
			error: getErrorMessage(error),
		})
		return []
	}

	const killedSessionNames: string[] = []

	for (const sessionName of candidateSessions) {
		const patternMatch = sessionName.match(TEAM_SESSION_PATTERN)
		const teamRunId = patternMatch?.[1]

		if (!teamRunId) {
			continue
		}

		if (activeTeamRunIds.has(teamRunId)) {
			continue
		}

		try {
			await deps.killSession(sessionName)
			killedSessionNames.push(sessionName)
		} catch (error) {
			deps.log("[sweepStaleTeamSessionsWith] failed to kill stale team session", {
				error: getErrorMessage(error),
				sessionName,
				teamRunId,
			})
		}
	}

	return killedSessionNames
}

export async function sweepStaleTeamSessions(activeTeamRunIds: ReadonlySet<string>): Promise<string[]> {
	const runtimeDeps = await buildRuntimeDeps()
	const tmuxPath = await runtimeDeps.getTmuxPath()

	if (!tmuxPath) {
		return []
	}

	return sweepStaleTeamSessionsWith(activeTeamRunIds, {
		listCandidates: () => listTeamSessionsViaTmux(tmuxPath),
		killSession: (sessionName) => killTeamSessionViaTmux(tmuxPath, sessionName),
		log: runtimeDeps.log,
	})
}
