import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile, open } from "node:fs/promises"

type LockOptions = {
  staleAfterMs?: number
  ownerTag?: string
}

const LOCK_RETRY_MS = 50

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function buildOwnerContent(ownerTag: string): string {
  return `${ownerTag}\n${process.pid}\n${Date.now()}`
}

function parseOwnerContent(content: string): { ownerPid: number; acquiredAtEpochMs: number } | null {
  const lines = content.split("\n")
  if (lines.length !== 3) return null

  const ownerPid = Number.parseInt(lines[1] ?? "", 10)
  const acquiredAtEpochMs = Number.parseInt(lines[2] ?? "", 10)
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null
  if (!Number.isInteger(acquiredAtEpochMs) || acquiredAtEpochMs <= 0) return null

  return { ownerPid, acquiredAtEpochMs }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireLock(lockPath: string, ownerTag: string, staleAfterMs: number): Promise<void> {
  for (;;) {
    try {
      await mkdir(lockPath)
      await writeFile(`${lockPath}/owner`, buildOwnerContent(ownerTag))
      return
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code !== "EEXIST") throw error

      if (await detectStaleLock(lockPath, staleAfterMs)) {
        await reapStaleLock(lockPath)
        continue
      }

      await delay(LOCK_RETRY_MS)
    }
  }
}

export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: LockOptions,
): Promise<T> {
  const staleAfterMs = opts?.staleAfterMs ?? 300_000
  const ownerTag = opts?.ownerTag ?? "owner"

  await acquireLock(lockPath, ownerTag, staleAfterMs)

  try {
    return await fn()
  } finally {
    await reapStaleLock(lockPath)
  }
}

export async function detectStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  try {
    const content = await readFile(`${lockPath}/owner`, "utf8")
    const parsed = parseOwnerContent(content)
    if (parsed === null) return false

    if (isPidAlive(parsed.ownerPid)) return false

    return Date.now() - parsed.acquiredAtEpochMs > staleAfterMs
  } catch {
    return false
  }
}

export async function reapStaleLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true })
}

export async function atomicWrite(
  filePath: string,
  content: string | Buffer,
): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomUUID()}`

  try {
    await writeFile(tmpPath, content)
    const fileHandle = await open(tmpPath, "r")
    try {
      await fileHandle.sync()
    } finally {
      await fileHandle.close()
    }
    await rename(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true })
    throw error
  }
}
