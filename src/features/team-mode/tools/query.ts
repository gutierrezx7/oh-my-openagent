import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { loadTeamSpec } from "../team-registry/loader"
import { aggregateStatus } from "../team-runtime/status"
import { discoverTeamSpecs } from "../team-registry/paths"
import { listActiveTeams } from "../team-state-store/store"

type TeamListScope = "user" | "project" | "all"

type TeamListEntry = {
  name: string
  scope: "user" | "project"
  status: string
  teamRunId?: string
  memberCount: number
}

function getProjectRoot(): string {
  return process.cwd()
}

export function createTeamStatusTool(config: TeamModeConfig, backgroundManager?: Parameters<typeof aggregateStatus>[2]): ToolDefinition {
  return tool({
    description: "Return full status for a team run.",
    args: {
      teamRunId: tool.schema.string().describe("Team run ID"),
    },
    execute: async (args: { teamRunId: string }) => JSON.stringify(await aggregateStatus(args.teamRunId, config, backgroundManager)),
  })
}

export function createTeamListTool(config: TeamModeConfig): ToolDefinition {
  return tool({
    description: "List declared and active teams.",
    args: {
      scope: tool.schema.union([
        tool.schema.literal("user"),
        tool.schema.literal("project"),
        tool.schema.literal("all"),
      ]).optional().describe("Team scope filter"),
    },
    execute: async (args: { scope?: TeamListScope }) => {
      const scope = args.scope ?? "all"
      const projectRoot = getProjectRoot()
      const declaredTeamSpecs = await discoverTeamSpecs(config, projectRoot)
      const activeTeams = await listActiveTeams(config)

      const filteredDeclaredTeamSpecs = scope === "all"
        ? declaredTeamSpecs
        : declaredTeamSpecs.filter((teamSpec) => teamSpec.scope === scope)

      const declaredTeamSpecsByName = new Map(
        await Promise.all(filteredDeclaredTeamSpecs.map(async (teamSpec) => {
          const loadedTeamSpec = await loadTeamSpec(teamSpec.name, config, projectRoot)
          return [teamSpec.name, { scope: teamSpec.scope, memberCount: loadedTeamSpec.members.length }] as const
        })),
      )

      const activeTeamsByName = new Map(activeTeams.map((team) => [team.teamName, team]))

      const teamEntries: TeamListEntry[] = []

      for (const declaredTeamSpec of filteredDeclaredTeamSpecs) {
        const activeTeam = activeTeamsByName.get(declaredTeamSpec.name)
        const declaredTeamSpecDetails = declaredTeamSpecsByName.get(declaredTeamSpec.name)
        teamEntries.push({
          name: declaredTeamSpec.name,
          scope: declaredTeamSpec.scope,
          status: activeTeam?.status ?? "not-started",
          teamRunId: activeTeam?.teamRunId,
          memberCount: activeTeam?.memberCount ?? declaredTeamSpecDetails?.memberCount ?? 0,
        })
      }

      for (const activeTeam of activeTeams) {
        if (filteredDeclaredTeamSpecs.some((teamSpec) => teamSpec.name === activeTeam.teamName)) continue

        teamEntries.push({
          name: activeTeam.teamName,
          scope: activeTeam.scope,
          status: activeTeam.status,
          teamRunId: activeTeam.teamRunId,
          memberCount: activeTeam.memberCount,
        })
      }

      return JSON.stringify(teamEntries)
    },
  })
}
