import { mkdir, rename } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { getInboxDir, resolveBaseDir } from "../team-registry/paths"

export interface DeliveryReservation {
  reservedPath: string
  inboxPath: string
  processedPath: string
  processedDir: string
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

export async function reserveMessageForDelivery(
  teamRunId: string,
  recipientName: string,
  messageId: string,
  config: TeamModeConfig,
): Promise<DeliveryReservation | null> {
  const inboxDir = getInboxDir(resolveBaseDir(config), teamRunId, recipientName)
  const inboxPath = path.join(inboxDir, `${messageId}.json`)
  const reservedPath = path.join(inboxDir, `.delivering-${messageId}.json`)
  const processedDir = path.join(inboxDir, "processed")
  const processedPath = path.join(processedDir, `${messageId}.json`)

  try {
    await rename(inboxPath, reservedPath)
    return { reservedPath, inboxPath, processedPath, processedDir }
  } catch (error) {
    if (isMissingPathError(error)) {
      return null
    }
    throw error
  }
}

export async function commitDeliveryReservation(reservation: DeliveryReservation): Promise<void> {
  await mkdir(reservation.processedDir, { recursive: true, mode: 0o700 })
  await rename(reservation.reservedPath, reservation.processedPath)
}

export async function releaseDeliveryReservation(reservation: DeliveryReservation): Promise<void> {
  await rename(reservation.reservedPath, reservation.inboxPath)
}
