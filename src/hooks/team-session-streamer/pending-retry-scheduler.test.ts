/// <reference types="bun-types" />

import { describe, expect, mock, test } from "bun:test"

import { createPendingRetryScheduler } from "./pending-retry-scheduler"

describe("createPendingRetryScheduler", () => {
  test("keeps draining remaining sessions in the same tick when drainSession throws", async () => {
    // given
    const pending = new Set(["session-a", "session-b", "session-c"])
    const drained: string[] = []
    const drainSession = mock(async (sessionID: string) => {
      drained.push(sessionID)
      if (sessionID === "session-b") throw new Error("simulated drain failure")
      pending.delete(sessionID)
    })
    const scheduler = createPendingRetryScheduler({
      intervalMs: 10,
      getPendingSessions: () => Array.from(pending),
      drainSession,
    })

    // when
    scheduler.schedule()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))
    scheduler.stop()
    pending.clear()

    // then
    expect(drained.slice(0, 3)).toEqual(["session-a", "session-b", "session-c"])
    expect(drained.includes("session-b")).toBe(true)
  })

  test("stops when stop is called before the timer fires", async () => {
    // given
    const drainSession = mock(async () => {})
    const scheduler = createPendingRetryScheduler({
      intervalMs: 50,
      getPendingSessions: () => ["session-a"],
      drainSession,
    })

    // when
    scheduler.schedule()
    scheduler.stop()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))

    // then
    expect(drainSession).not.toHaveBeenCalled()
  })

  test("drains each pending session exactly once per tick", async () => {
    // given
    const pending = new Set(["session-a", "session-b"])
    const drainSession = mock(async (sessionID: string) => {
      pending.delete(sessionID)
    })
    const scheduler = createPendingRetryScheduler({
      intervalMs: 10,
      getPendingSessions: () => Array.from(pending),
      drainSession,
    })

    // when
    scheduler.schedule()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40))

    // then
    expect(drainSession).toHaveBeenCalledTimes(2)
    expect(pending.size).toBe(0)
    scheduler.stop()
  })
})
