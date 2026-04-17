import { mkdir, open } from "node:fs/promises"
import path from "node:path"

export async function writeTeamSessionFifo(fifoPath: string, text: string): Promise<void> {
  if (text.length === 0) return

  await mkdir(path.dirname(fifoPath), { recursive: true })

  const fileHandle = await open(fifoPath, "a")
  try {
    await fileHandle.write(text)
  } finally {
    await fileHandle.close()
  }
}
