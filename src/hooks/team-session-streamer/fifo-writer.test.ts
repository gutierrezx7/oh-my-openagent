/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { ensureTeamMemberFifo } from "../../features/team-mode/team-layout-tmux/ensure-team-member-fifo"
import { writeTeamSessionFifo } from "./fifo-writer"

const TEAM_ROOT = "/tmp/omo-team"

describe("writeTeamSessionFifo", () => {
  const registeredPaths: string[] = []

  afterEach(async () => {
    await Promise.all(registeredPaths.splice(0).map(async (registeredPath) => {
      await rm(registeredPath, { recursive: true, force: true })
    }))
  })

  test("appends text to the team member stream file so multiple readers observe the same content", async () => {
    // given
    const scratchDir = await mkdtemp(path.join(tmpdir(), "team-stream-"))
    registeredPaths.push(scratchDir)
    const teamRunId = `qa-stream-${path.basename(scratchDir)}`
    registeredPaths.push(path.join(TEAM_ROOT, teamRunId))
    const streamPath = await ensureTeamMemberFifo(teamRunId, "member-a")

    // when
    await writeTeamSessionFifo(streamPath, "hello ")
    await writeTeamSessionFifo(streamPath, "world\n")
    await writeTeamSessionFifo(streamPath, "next-line\n")

    // then
    const readerOne = await readFile(streamPath, "utf8")
    const readerTwo = await readFile(streamPath, "utf8")
    expect(readerOne).toBe("hello world\nnext-line\n")
    expect(readerTwo).toBe(readerOne)
  })

  test("creates the stream file on first ensureTeamMemberFifo and allows concurrent appends to preserve order", async () => {
    // given
    const scratchDir = await mkdtemp(path.join(tmpdir(), "team-stream-"))
    registeredPaths.push(scratchDir)
    const teamRunId = `qa-concurrent-${path.basename(scratchDir)}`
    registeredPaths.push(path.join(TEAM_ROOT, teamRunId))
    const streamPath = await ensureTeamMemberFifo(teamRunId, "member-b")

    // when
    const writes: Promise<void>[] = []
    for (let i = 1; i <= 20; i++) {
      writes.push(writeTeamSessionFifo(streamPath, `n=${i}\n`))
    }
    await Promise.all(writes)

    // then
    const content = await readFile(streamPath, "utf8")
    for (let i = 1; i <= 20; i++) {
      expect(content).toContain(`n=${i}\n`)
    }
  })

  test("is a no-op for empty text", async () => {
    // given
    const scratchDir = await mkdtemp(path.join(tmpdir(), "team-stream-"))
    registeredPaths.push(scratchDir)
    const teamRunId = `qa-empty-${path.basename(scratchDir)}`
    registeredPaths.push(path.join(TEAM_ROOT, teamRunId))
    const streamPath = await ensureTeamMemberFifo(teamRunId, "member-c")

    // when
    await writeTeamSessionFifo(streamPath, "")

    // then
    const content = await readFile(streamPath, "utf8")
    expect(content).toBe("")
  })

  test("re-invoking ensureTeamMemberFifo preserves content already written (late reader race guard)", async () => {
    // given
    const scratchDir = await mkdtemp(path.join(tmpdir(), "team-stream-"))
    registeredPaths.push(scratchDir)
    const teamRunId = `qa-late-race-${path.basename(scratchDir)}`
    registeredPaths.push(path.join(TEAM_ROOT, teamRunId))
    const streamPath = await ensureTeamMemberFifo(teamRunId, "member-d")
    await writeTeamSessionFifo(streamPath, "early-line-1\nearly-line-2\n")

    // when
    const streamPathAgain = await ensureTeamMemberFifo(teamRunId, "member-d")
    await writeTeamSessionFifo(streamPath, "late-line-3\n")

    // then
    expect(streamPathAgain).toBe(streamPath)
    const content = await readFile(streamPath, "utf8")
    expect(content).toBe("early-line-1\nearly-line-2\nlate-line-3\n")
  })

  test("creates the parent directory on demand so early hook writes do not vanish to ENOENT", async () => {
    // given
    const scratchDir = await mkdtemp(path.join(tmpdir(), "team-stream-"))
    registeredPaths.push(scratchDir)
    const teamRunId = `qa-noent-${path.basename(scratchDir)}`
    const streamRoot = path.join(TEAM_ROOT, teamRunId)
    registeredPaths.push(streamRoot)
    const streamPath = path.join(streamRoot, "member-z.fifo")

    // when
    await writeTeamSessionFifo(streamPath, "arrived-before-ensure\n")

    // then
    const content = await readFile(streamPath, "utf8")
    expect(content).toBe("arrived-before-ensure\n")
  })
})
