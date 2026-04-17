import { mkdir, rm } from "node:fs/promises"
import path from "node:path"

import { spawn } from "bun"

import { getTeamMemberFifoPath } from "./fifo-path"

export async function ensureTeamMemberFifo(teamRunId: string, memberName: string): Promise<string> {
  const fifoPath = getTeamMemberFifoPath(teamRunId, memberName)
  await mkdir(path.dirname(fifoPath), { recursive: true })
  await rm(fifoPath, { force: true })

  const process = spawn(["mkfifo", fifoPath], { stdout: "pipe", stderr: "pipe" })
  const errorOutputPromise = new Response(process.stderr).text()
  const exitCode = await process.exited
  const errorOutput = (await errorOutputPromise).trim()
  if (exitCode !== 0) {
    throw new Error(errorOutput.length > 0 ? errorOutput : `mkfifo failed for ${fifoPath}`)
  }

  return fifoPath
}
