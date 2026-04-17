import { mkdir, open, rm } from "node:fs/promises"
import path from "node:path"

import { getTeamMemberFifoPath } from "./fifo-path"

export async function ensureTeamMemberFifo(teamRunId: string, memberName: string): Promise<string> {
  const fifoPath = getTeamMemberFifoPath(teamRunId, memberName)
  await mkdir(path.dirname(fifoPath), { recursive: true })
  await rm(fifoPath, { force: true })

  const fileHandle = await open(fifoPath, "w")
  await fileHandle.close()

  return fifoPath
}
