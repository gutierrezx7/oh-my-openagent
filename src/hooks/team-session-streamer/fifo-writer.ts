import { open } from "node:fs/promises"

export async function writeTeamSessionFifo(fifoPath: string, text: string): Promise<void> {
  if (text.length === 0) return

  const fileHandle = await open(fifoPath, "a")
  try {
    await fileHandle.write(text)
  } finally {
    await fileHandle.close()
  }
}
