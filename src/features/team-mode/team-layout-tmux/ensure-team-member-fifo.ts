import { mkdir, open } from "node:fs/promises"
import path from "node:path"

import { getTeamMemberFifoPath } from "./fifo-path"

export async function ensureTeamMemberFifo(teamRunId: string, memberName: string): Promise<string> {
  const fifoPath = getTeamMemberFifoPath(teamRunId, memberName)
  await mkdir(path.dirname(fifoPath), { recursive: true })

  const fileHandle = await open(fifoPath, "a")
  await fileHandle.close()

  return fifoPath
}
