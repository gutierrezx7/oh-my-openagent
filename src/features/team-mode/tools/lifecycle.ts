import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import type { ToolContext } from "@opencode-ai/plugin/tool"
import { z } from "zod"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { BackgroundManager } from "../../background-agent/manager"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { loadTeamSpec, normalizeTeamSpecInput } from "../team-registry/loader"
import { validateSpec } from "../team-registry/validator"
import { createTeamRun } from "../team-runtime/create"
import { approveShutdown, deleteTeam, rejectShutdown, requestShutdownOfMember } from "../team-runtime/shutdown"
import { listActiveTeams, loadRuntimeState } from "../team-state-store/store"
import { TeamSpecSchema, type RuntimeState } from "../types"

const ACTIVE_RUNTIME_STATUSES = new Set<RuntimeState["status"]>(["creating", "active", "shutdown_requested"])

const TeamCreateArgsSchema = z.object({
  teamName: z.string().min(1).optional(),
  inline_spec: z.unknown().optional(),
  leadSessionId: z.string().min(1).optional(),
}).superRefine((value, ctx) => {
  const optionCount = Number(value.teamName !== undefined) + Number(value.inline_spec !== undefined)
  if (optionCount !== 1) {
    ctx.addIssue({ code: "custom", message: "Provide exactly one of teamName or inline_spec." })
  }
})

const TeamDeleteArgsSchema = z.object({ teamRunId: z.string().min(1) })
const TeamShutdownRequestArgsSchema = z.object({ teamRunId: z.string().min(1), targetMemberName: z.string().min(1) })
const TeamApproveShutdownArgsSchema = z.object({ teamRunId: z.string().min(1), memberName: z.string().min(1) })
const TeamRejectShutdownArgsSchema = z.object({
  teamRunId: z.string().min(1),
  memberName: z.string().min(1),
  reason: z.string().min(1),
})

type TeamLifecycleToolContext = ToolContext & {
  sessionID: string
  directory?: string
  client?: ExecutorContext["client"]
}

type TeamParticipant = { role: "lead" | "member"; memberName: string }

function getLeadMemberName(runtimeState: RuntimeState): string {
  const leadMember = runtimeState.members.find((member) => member.agentType === "leader")
  if (!leadMember) throw new Error(`team '${runtimeState.teamRunId}' is missing a lead member`)
  return leadMember.name
}

function sanitizeRuntimeState(runtimeState: RuntimeState): Omit<RuntimeState, "members"> & {
  members: Array<Omit<RuntimeState["members"][number], "lastInjectedTurnMarker" | "pendingInjectedMessageIds">>
} {
  return {
    ...runtimeState,
    members: runtimeState.members.map(({ lastInjectedTurnMarker: _turnMarker, pendingInjectedMessageIds: _pendingIds, ...member }) => member),
  }
}

function resolveProjectRoot(toolContext: TeamLifecycleToolContext): string {
  return typeof toolContext.directory === "string" ? toolContext.directory : process.cwd()
}

function resolveRuntimeClient(toolContext: TeamLifecycleToolContext): ExecutorContext["client"] {
  if (!toolContext.client) throw new Error("team-mode lifecycle tools require tool context client")
  return toolContext.client
}

function serializeResult(result: Record<string, unknown>): string {
  return JSON.stringify(result)
}

function parseInlineTeamSpec(rawSpec: unknown) {
  const parsedSpec = TeamSpecSchema.parse(normalizeTeamSpecInput(rawSpec))
  validateSpec(parsedSpec)
  return parsedSpec
}

async function findParticipantRuntime(sessionID: string, config: TeamModeConfig): Promise<RuntimeState | undefined> {
  for (const activeTeam of await listActiveTeams(config)) {
    const runtimeState = await loadRuntimeState(activeTeam.teamRunId, config).catch(() => undefined)
    if (!runtimeState || !ACTIVE_RUNTIME_STATUSES.has(runtimeState.status)) continue
    if (runtimeState.leadSessionId === sessionID) return runtimeState
    if (runtimeState.members.some((member) => member.sessionId === sessionID)) return runtimeState
  }
}

async function resolveParticipant(teamRunId: string, sessionID: string, config: TeamModeConfig): Promise<{ runtimeState: RuntimeState; participant?: TeamParticipant }> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  if (runtimeState.leadSessionId === sessionID) {
    return { runtimeState, participant: { role: "lead", memberName: getLeadMemberName(runtimeState) } }
  }
  const member = runtimeState.members.find((candidate) => candidate.sessionId === sessionID)
  return member ? { runtimeState, participant: { role: "member", memberName: member.name } } : { runtimeState }
}

export function createTeamCreateTool(config: TeamModeConfig, bgMgr: BackgroundManager, tmuxMgr?: TmuxSessionManager): ToolDefinition {
  return tool({
    description: "Create a team run from a named or inline team spec.",
    args: { teamName: tool.schema.string().optional(), inline_spec: tool.schema.unknown().optional(), leadSessionId: tool.schema.string().optional() },
    async execute(rawArgs, toolContext) {
      const args = TeamCreateArgsSchema.parse(rawArgs)
      const runtimeContext = toolContext as TeamLifecycleToolContext
      const leadSessionId = args.leadSessionId ?? runtimeContext.sessionID
      if (!leadSessionId) throw new Error("team_create requires leadSessionId or tool context sessionID")
      const projectRoot = resolveProjectRoot(runtimeContext)
      const spec = args.teamName ? await loadTeamSpec(args.teamName, config, projectRoot) : parseInlineTeamSpec(args.inline_spec)
      const participantRuntime = await findParticipantRuntime(runtimeContext.sessionID, config)
      if (participantRuntime && (participantRuntime.teamName !== spec.name || participantRuntime.leadSessionId !== leadSessionId)) {
        throw new Error(`team_create denied: session is already a participant of team ${participantRuntime.teamRunId}`)
      }
      const runtimeState = await createTeamRun(spec, leadSessionId, { client: resolveRuntimeClient(runtimeContext), manager: bgMgr, directory: projectRoot }, config, bgMgr, tmuxMgr)
      return serializeResult({ teamRunId: runtimeState.teamRunId, runtimeState: sanitizeRuntimeState(runtimeState) })
    },
  })
}

export function createTeamDeleteTool(config: TeamModeConfig, _bgMgr: BackgroundManager, tmuxMgr?: TmuxSessionManager): ToolDefinition {
  return tool({
    description: "Delete a completed or shutdown-approved team run.",
    args: { teamRunId: tool.schema.string() },
    async execute(rawArgs, toolContext) {
      const args = TeamDeleteArgsSchema.parse(rawArgs)
      const runtimeContext = toolContext as TeamLifecycleToolContext
      const { runtimeState, participant } = await resolveParticipant(args.teamRunId, runtimeContext.sessionID, config)
      if (participant?.role !== "lead") throw new Error("team_delete is lead-only")
      return serializeResult({ teamRunId: args.teamRunId, teamName: runtimeState.teamName, deleted: true, ...(await deleteTeam(args.teamRunId, config, tmuxMgr, _bgMgr)) })
    },
  })
}

export function createTeamShutdownRequestTool(config: TeamModeConfig): ToolDefinition {
  return tool({
    description: "Request shutdown for a team member.",
    args: { teamRunId: tool.schema.string(), targetMemberName: tool.schema.string() },
    async execute(rawArgs, toolContext) {
      const args = TeamShutdownRequestArgsSchema.parse(rawArgs)
      const runtimeContext = toolContext as TeamLifecycleToolContext
      const { participant } = await resolveParticipant(args.teamRunId, runtimeContext.sessionID, config)
      if (participant?.role !== "lead") throw new Error("team_shutdown_request is lead-only")
      await requestShutdownOfMember(args.teamRunId, args.targetMemberName, participant.memberName, config)
      return serializeResult({ teamRunId: args.teamRunId, targetMemberName: args.targetMemberName, requesterName: participant.memberName, status: "shutdown_requested" })
    },
  })
}

export function createTeamApproveShutdownTool(config: TeamModeConfig): ToolDefinition {
  return tool({
    description: "Approve a pending shutdown request.",
    args: { teamRunId: tool.schema.string(), memberName: tool.schema.string() },
    async execute(rawArgs, toolContext) {
      const args = TeamApproveShutdownArgsSchema.parse(rawArgs)
      const runtimeContext = toolContext as TeamLifecycleToolContext
      const { participant } = await resolveParticipant(args.teamRunId, runtimeContext.sessionID, config)
      if (!participant || (participant.role !== "lead" && participant.memberName !== args.memberName)) throw new Error("team_approve_shutdown: caller must be target member or team lead")
      await approveShutdown(args.teamRunId, args.memberName, participant.memberName, config)
      return serializeResult({ teamRunId: args.teamRunId, memberName: args.memberName, approverName: participant.memberName, status: "shutdown_approved" })
    },
  })
}

export function createTeamRejectShutdownTool(config: TeamModeConfig): ToolDefinition {
  return tool({
    description: "Reject a pending shutdown request.",
    args: { teamRunId: tool.schema.string(), memberName: tool.schema.string(), reason: tool.schema.string() },
    async execute(rawArgs, toolContext) {
      const args = TeamRejectShutdownArgsSchema.parse(rawArgs)
      const runtimeContext = toolContext as TeamLifecycleToolContext
      const { participant } = await resolveParticipant(args.teamRunId, runtimeContext.sessionID, config)
      if (!participant || (participant.role !== "lead" && participant.memberName !== args.memberName)) throw new Error("team_reject_shutdown: caller must be target member or team lead")
      await rejectShutdown(args.teamRunId, args.memberName, args.reason, config)
      return serializeResult({ teamRunId: args.teamRunId, memberName: args.memberName, rejectedBy: participant.memberName, reason: args.reason, status: "shutdown_rejected" })
    },
  })
}
