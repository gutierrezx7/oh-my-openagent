/// <reference types="bun-types" />

export async function closeTeamMemberPane(paneId: string): Promise<boolean> {
	if (paneId.length === 0) {
		return false
	}

	const [{ log }, { closeTmuxPane }] = await Promise.all([
		import("../../../shared"),
		import("../../../shared/tmux"),
	])

	try {
		return await closeTmuxPane(paneId)
	} catch (error) {
		log("[closeTeamMemberPane] FAILED", {
			paneId,
			error: error instanceof Error ? error.message : String(error),
		})
		return false
	}
}
