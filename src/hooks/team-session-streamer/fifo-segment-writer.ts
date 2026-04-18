import { log } from "../../shared/logger"
import { writeTeamSessionFifo } from "./fifo-writer"

const DROPPABLE_FIFO_ERROR_CODES = new Set(["ENXIO", "ENOENT", "EPIPE"])

function isErrorWithCode(error: unknown): error is Error & { code: string } {
  return error instanceof Error && "code" in error && typeof error.code === "string"
}

export type FifoWriteOutcome = {
  written: boolean
  clearCache: boolean
}

export type FifoWriteContext = {
  teamRunId: string
  memberName: string
  sessionID: string
  fifoPath: string
}

export async function writeFifoSegment(context: FifoWriteContext, text: string): Promise<FifoWriteOutcome> {
  try {
    await writeTeamSessionFifo(context.fifoPath, text)
    return { written: true, clearCache: false }
  } catch (error) {
    if (isErrorWithCode(error) && DROPPABLE_FIFO_ERROR_CODES.has(error.code)) {
      return { written: false, clearCache: error.code === "ENOENT" }
    }
    log("team session streamer write failed", {
      event: "team-mode-session-streamer-write-error",
      teamRunId: context.teamRunId,
      memberName: context.memberName,
      sessionID: context.sessionID,
      fifoPath: context.fifoPath,
      error: error instanceof Error ? error.message : String(error),
    })
    return { written: false, clearCache: false }
  }
}
