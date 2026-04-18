import { randomUUID } from "node:crypto"

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import type { OpencodeClient } from "../../../tools/delegate-task/types"
import { listActiveTeams, loadRuntimeState } from "../team-state-store/store"
import { BroadcastNotPermittedError, sendMessage } from "../team-mailbox/send"

import { MessageSchema } from "../types"

const MESSAGE_TOOL_KINDS = ["message", "announcement"] as const

type TeamRuntimeDetails = {
  teamRunId: string
  isLead: boolean
  senderName: string
  activeMembers: string[]
}

async function resolveTeamRuntimeDetails(teamRunId: string, sessionID: string, config: TeamModeConfig): Promise<TeamRuntimeDetails> {
  const activeTeams = await listActiveTeams(config)

  for (const team of activeTeams) {
    if (team.teamRunId !== teamRunId) continue

    const runtimeState = await loadRuntimeState(team.teamRunId, config)
    const isLead = runtimeState.leadSessionId === sessionID
    const leadMember = isLead
      ? runtimeState.members.find((member) => member.agentType === "leader")
      : undefined
    const member = runtimeState.members.find((entry) => entry.sessionId === sessionID)

    return {
      teamRunId: runtimeState.teamRunId,
      isLead,
      senderName: leadMember?.name ?? member?.name ?? "unknown",
      activeMembers: runtimeState.members
        .filter((entry) => entry.sessionId !== undefined)
        .map((entry) => entry.name),
    }
  }

  return {
    teamRunId,
    isLead: false,
    senderName: "unknown",
    activeMembers: [],
  }
}

export function createTeamSendMessageTool(config: TeamModeConfig, client: OpencodeClient): ToolDefinition {
  void client

  return tool({
    description: "Send a message to a team member or broadcast to the team.",
    args: {
      teamRunId: tool.schema.string().describe("Team run ID"),
      to: tool.schema.string().describe("Recipient name or * for broadcast"),
      body: tool.schema.string().describe("Message body"),
      kind: tool.schema.enum(MESSAGE_TOOL_KINDS).optional().default("message").describe("Message kind"),
      correlationId: tool.schema.string().optional().describe("Optional correlation ID"),
      summary: tool.schema.string().optional().describe("Optional summary"),
      references: tool.schema.array(tool.schema.any()).optional().describe("Optional references"),
    },
    execute: async (args, context) => {
      const runtimeContext = context as { sessionID?: string }
      const sessionID = runtimeContext.sessionID

      if (!sessionID) {
        throw new Error("session ID is required")
      }

      const teamRuntime = await resolveTeamRuntimeDetails(args.teamRunId, sessionID, config)
      const message = MessageSchema.parse({
        version: 1,
        messageId: randomUUID(),
        from: teamRuntime.senderName,
        to: args.to,
        body: args.body,
        kind: args.kind ?? "message",
        timestamp: Date.now(),
        correlationId: args.correlationId,
        summary: args.summary,
        references: args.references,
      })

      if (message.kind === "shutdown_request" || message.kind === "shutdown_approved" || message.kind === "shutdown_rejected") {
        throw new Error("must use lifecycle tools for shutdown kinds")
      }

      if (message.to === "*" && !teamRuntime.isLead) {
        throw new BroadcastNotPermittedError()
      }

      const result = await sendMessage(message, teamRuntime.teamRunId, config, {
        isLead: teamRuntime.isLead,
        activeMembers: teamRuntime.activeMembers,
      })

      return JSON.stringify(result)
    },
  })
}
