import { readFile } from "node:fs/promises"

import { ZodError } from "zod"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { log } from "../../../shared/logger"
import { TeamSpecSchema } from "../types"

import type { TeamSpec } from "../types"
import { discoverTeamSpecs, getTeamSpecPath, resolveBaseDir } from "./paths"
import { TeamSpecValidationError, validateSpec } from "./validator"

type DiscoveredTeamSpec = Awaited<ReturnType<typeof discoverTeamSpecs>>[number]
type JsonRecord = Record<string, unknown>

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function createSpecialCaseValidationError(rawSpec: unknown): TeamSpecValidationError | undefined {
  if (!isJsonRecord(rawSpec)) {
    return undefined
  }

  const rawMembers = rawSpec.members
  if (Array.isArray(rawMembers) && rawMembers.length > 8) {
    const teamName = typeof rawSpec.name === "string" ? rawSpec.name : "<unknown>"
    return new TeamSpecValidationError(
      `Team '${teamName}' exceeds max 8 members.`,
      "TEAM_MEMBER_LIMIT_EXCEEDED",
      "members",
    )
  }

  if (!Array.isArray(rawMembers)) {
    return undefined
  }

  for (const rawMember of rawMembers) {
    if (!isJsonRecord(rawMember)) {
      continue
    }

    const memberName = typeof rawMember.name === "string" ? rawMember.name : "<unknown>"
    const hasKind = Object.hasOwn(rawMember, "kind")
    const hasCategory = Object.hasOwn(rawMember, "category")
    const hasSubagentType = Object.hasOwn(rawMember, "subagent_type")

    if (hasCategory && hasSubagentType) {
      return new TeamSpecValidationError(
        `Member '${memberName}' specifies both 'category' and 'subagent_type'. Must specify exactly one via 'kind' discriminator.`,
        "AMBIGUOUS_MEMBER_KIND",
        "kind",
        memberName,
      )
    }

    if (!hasKind) {
      return new TeamSpecValidationError(
        `Member '${memberName}' missing 'kind' discriminator. Specify either {kind:'category', category, prompt} or {kind:'subagent_type', subagent_type}.`,
        "MISSING_MEMBER_KIND",
        "kind",
        memberName,
      )
    }

    if (rawMember.kind === "category" && !Object.hasOwn(rawMember, "prompt")) {
      const category = typeof rawMember.category === "string" ? rawMember.category : "<unknown>"
      return new TeamSpecValidationError(
        `Member '${memberName}' uses category '${category}' but is missing required 'prompt' field. Category members must supply a task prompt.`,
        "MISSING_CATEGORY_PROMPT",
        "prompt",
        memberName,
      )
    }
  }

  return undefined
}

function createZodValidationError(rawSpec: unknown, error: ZodError): TeamSpecValidationError {
  const specialCaseError = createSpecialCaseValidationError(rawSpec)
  if (specialCaseError) {
    return specialCaseError
  }

  const firstIssue = error.issues[0]
  const field = firstIssue?.path.join(".") || undefined
  const message = field
    ? `Invalid team spec field '${field}': ${firstIssue.message}`
    : `Invalid team spec: ${error.message}`

  return new TeamSpecValidationError(message, "INVALID_TEAM_SPEC", field)
}

async function loadTeamSpecFromEntry(entry: DiscoveredTeamSpec): Promise<TeamSpec> {
  let rawText: string
  try {
    rawText = await readFile(entry.path, "utf8")
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TeamSpecValidationError(`Failed to read team spec '${entry.name}': ${reason}`, "TEAM_SPEC_READ_FAILED")
  }

  let rawSpec: unknown
  try {
    rawSpec = JSON.parse(rawText) as unknown
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TeamSpecValidationError(`Failed to parse team spec '${entry.name}' JSON: ${reason}`, "INVALID_JSON")
  }

  const parsedSpec = TeamSpecSchema.safeParse(rawSpec)
  if (!parsedSpec.success) {
    throw createZodValidationError(rawSpec, parsedSpec.error)
  }

  validateSpec(parsedSpec.data)
  return parsedSpec.data
}

export { TeamSpecValidationError } from "./validator"

export async function loadTeamSpec(
  teamName: string,
  config: TeamModeConfig,
  projectRoot: string,
): Promise<TeamSpec> {
  const discoveredTeamSpecs = await discoverTeamSpecs(config, projectRoot)
  const matchedTeamSpec = discoveredTeamSpecs.find((entry) => entry.name === teamName)

  if (!matchedTeamSpec) {
    const baseDir = resolveBaseDir(config)
    const projectSpecPath = getTeamSpecPath(baseDir, teamName, "project", projectRoot)
    const userSpecPath = getTeamSpecPath(baseDir, teamName, "user")
    throw new TeamSpecValidationError(
      `Team '${teamName}' was not found. Expected '${projectSpecPath}' or '${userSpecPath}'.`,
      "TEAM_SPEC_NOT_FOUND",
      "name",
    )
  }

  return await loadTeamSpecFromEntry(matchedTeamSpec)
}

export async function loadAllTeamSpecs(
  config: TeamModeConfig,
  projectRoot: string,
): Promise<Array<{ name: string; scope: "project" | "user"; spec?: TeamSpec; error?: Error }>> {
  const discoveredTeamSpecs = await discoverTeamSpecs(config, projectRoot)

  return await Promise.all(discoveredTeamSpecs.map(async (entry) => {
    try {
      const spec = await loadTeamSpecFromEntry(entry)
      return { name: entry.name, scope: entry.scope, spec }
    } catch (error) {
      const normalizedError = error instanceof Error ? error : new Error(String(error))
      log("team-spec load failed", {
        event: "team-spec-load-failed",
        teamName: entry.name,
        scope: entry.scope,
        path: entry.path,
        error: normalizedError.message,
      })
      return { name: entry.name, scope: entry.scope, error: normalizedError }
    }
  }))
}
