import { Buffer } from "node:buffer"
import { mkdir, readdir, stat } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"
import { atomicWrite, withLock } from "../team-state-store/locks"
import type { Message } from "../types"

type SendContext = {
  isLead: boolean
  activeMembers: string[]
}

export class BroadcastNotPermittedError extends Error {
  constructor(message = "broadcast requires lead role") {
    super(message)
    this.name = "BroadcastNotPermittedError"
  }
}

export class PayloadTooLargeError extends Error {
  constructor(message = "payload exceeds 32 KB") {
    super(message)
    this.name = "PayloadTooLargeError"
  }
}

export class RecipientBackpressureError extends Error {
  constructor(message = "recipient inbox full (backpressure)") {
    super(message)
    this.name = "RecipientBackpressureError"
  }
}

export class DuplicateMessageIdError extends Error {
  constructor(message = "duplicate message id") {
    super(message)
    this.name = "DuplicateMessageIdError"
  }
}

function resolveRecipients(message: Message, context: SendContext): string[] {
  if (message.to !== "*") {
    return [message.to]
  }

  return [...new Set(context.activeMembers)]
}

async function getUnreadSizeBytes(inboxDir: string): Promise<number> {
  try {
    const directoryEntries = await readdir(inboxDir, { withFileTypes: true })
    const unreadEntries = directoryEntries.filter((entry) => (
      entry.isFile()
      && entry.name.endsWith(".json")
      && !entry.name.startsWith(".")
    ))

    const sizes = await Promise.all(unreadEntries.map(async (entry) => {
      const fileStats = await stat(path.join(inboxDir, entry.name))
      return fileStats.size
    }))

    return sizes.reduce((totalBytes, fileSize) => totalBytes + fileSize, 0)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      return 0
    }

    throw error
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      return false
    }

    throw error
  }
}

export async function sendMessage(
  message: Message,
  teamRunId: string,
  config: TeamModeConfig,
  context: SendContext,
): Promise<{ messageId: string; deliveredTo: string[] }> {
  const serializedMessage = `${JSON.stringify(message, null, 2)}\n`
  const payloadBytes = Buffer.byteLength(message.body, "utf8")
  if (payloadBytes > config.message_payload_max_bytes) {
    throw new PayloadTooLargeError()
  }

  if (message.to === "*" && !context.isLead) {
    throw new BroadcastNotPermittedError()
  }

  const baseDir = resolveBaseDir(config)
  const deliveredTo: string[] = []

  for (const recipient of resolveRecipients(message, context)) {
    const inboxDir = getInboxDir(baseDir, teamRunId, recipient)
    await mkdir(inboxDir, { recursive: true, mode: 0o700 })

    await withLock(`${inboxDir}.lock`, async () => {
      const unreadSizeBytes = await getUnreadSizeBytes(inboxDir)
      const nextUnreadSizeBytes = unreadSizeBytes + Buffer.byteLength(serializedMessage, "utf8")
      if (nextUnreadSizeBytes > config.recipient_unread_max_bytes) {
        throw new RecipientBackpressureError()
      }

      const messagePath = path.join(inboxDir, `${message.messageId}.json`)
      if (await fileExists(messagePath)) {
        throw new DuplicateMessageIdError()
      }

      await atomicWrite(messagePath, serializedMessage)
      deliveredTo.push(recipient)
    }, { ownerTag: `team-mailbox:${recipient}` })
  }

  return { messageId: message.messageId, deliveredTo }
}
