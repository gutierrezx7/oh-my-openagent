import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { log } from "../../../shared/logger"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"
import { MessageSchema } from "../types"
import type { Message } from "../types"

export async function listUnreadMessages(
  teamRunId: string,
  memberName: string,
  config: TeamModeConfig,
): Promise<Message[]> {
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, memberName)

  try {
    const directoryEntries = await readdir(inboxDir, { withFileTypes: true })
    const messageFileNames = directoryEntries
      .filter((entry) => (
        entry.isFile()
        && entry.name.endsWith(".json")
        && !entry.name.startsWith(".")
      ))
      .map((entry) => entry.name)

    const unreadMessages = await Promise.all(messageFileNames.map(async (fileName) => {
      const filePath = path.join(inboxDir, fileName)

      try {
        const fileContent = await readFile(filePath, "utf8")
        const parsedMessage = MessageSchema.safeParse(JSON.parse(fileContent))
        if (!parsedMessage.success) {
          log("team mailbox skipped malformed message", {
            event: "team-mailbox-malformed-message",
            memberName,
            teamRunId,
            fileName,
            issues: parsedMessage.error.issues,
          })
          return null
        }

        return parsedMessage.data
      } catch (error) {
        log("team mailbox skipped unreadable message", {
          event: "team-mailbox-unreadable-message",
          memberName,
          teamRunId,
          fileName,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    }))

    return unreadMessages
      .filter((message): message is Message => message !== null)
      .sort((leftMessage, rightMessage) => leftMessage.timestamp - rightMessage.timestamp)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === "ENOENT") {
      return []
    }

    throw error
  }
}
