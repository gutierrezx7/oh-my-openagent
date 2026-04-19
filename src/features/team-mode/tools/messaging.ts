import { randomUUID } from "node:crypto"

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { log } from "../../../shared/logger"
import type { OpencodeClient } from "../../../tools/delegate-task/types"
import { listActiveTeams, loadRuntimeState } from "../team-state-store/store"
import { buildEnvelope } from "../team-mailbox/poll"
import {
  commitDeliveryReservation,
  releaseDeliveryReservation,
  reserveMessageForDelivery,
} from "../team-mailbox/reservation"
import { BroadcastNotPermittedError, sendMessage } from "../team-mailbox/send"

import type { Message } from "../types"
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
    const senderName = leadMember?.name ?? member?.name ?? "unknown"

    return {
      teamRunId: runtimeState.teamRunId,
      isLead,
      senderName,
      activeMembers: runtimeState.members
        .map((entry) => entry.name)
        .filter((name) => name !== senderName),
    }
  }

  return {
    teamRunId,
    isLead: false,
    senderName: "unknown",
    activeMembers: [],
  }
}

async function deliverLive(
  client: OpencodeClient,
  message: Message,
  teamRunId: string,
  deliveredTo: readonly string[],
  config: TeamModeConfig,
): Promise<void> {
  const runtimeState = await loadRuntimeState(teamRunId, config)
  const envelope = buildEnvelope(message)

  for (const recipientName of deliveredTo) {
    const recipientMember = runtimeState.members.find((entry) => entry.name === recipientName)
    const recipientSessionId = recipientMember?.sessionId
    if (!recipientSessionId) continue

    // Reserve the inbox file before delivering so the transform-hook fallback
    // cannot re-read the same message while promptAsync is in flight.
    const reservation = await reserveMessageForDelivery(teamRunId, recipientName, message.messageId, config)
    if (reservation === null) continue

    try {
      await client.session.promptAsync({
        path: { id: recipientSessionId },
        body: { parts: [{ type: "text", text: envelope }] },
      })
      await commitDeliveryReservation(reservation)
    } catch (error) {
      log("[team-mailbox] live delivery failed, restoring inbox entry", {
        error: error instanceof Error ? error.message : String(error),
        teamRunId,
        recipient: recipientName,
        messageId: message.messageId,
      })
      try {
        await releaseDeliveryReservation(reservation)
      } catch (releaseError) {
        log("[team-mailbox] failed to release delivery reservation", {
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          teamRunId,
          recipient: recipientName,
          messageId: message.messageId,
        })
      }
    }
  }
}

export function createTeamSendMessageTool(config: TeamModeConfig, client: OpencodeClient): ToolDefinition {
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

      const runtimeState = await loadRuntimeState(teamRuntime.teamRunId, config)
      const reservedRecipients = new Set<string>(
        runtimeState.members
          .filter((member) => member.sessionId !== undefined && member.name !== teamRuntime.senderName)
          .map((member) => member.name),
      )

      const result = await sendMessage(message, teamRuntime.teamRunId, config, {
        isLead: teamRuntime.isLead,
        activeMembers: teamRuntime.activeMembers,
        reservedRecipients,
      })

      await deliverLive(client, message, teamRuntime.teamRunId, result.deliveredTo, config)

      return JSON.stringify(result)
    },
  })
}
