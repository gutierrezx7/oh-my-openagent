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

  test("aborts the in-flight run and does not reschedule when dispose is called during drain", async () => {
    // given
    const pending = new Set(["session-a", "session-b", "session-c"])
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const drained: string[] = []
    const drainSession = mock(async (sessionID: string) => {
      drained.push(sessionID)
      if (sessionID === "session-a") await gate
      pending.delete(sessionID)
    })
    const scheduler = createPendingRetryScheduler({
      intervalMs: 10,
      getPendingSessions: () => Array.from(pending),
      drainSession,
    })

    // when
    scheduler.schedule()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 30))
    scheduler.dispose()
    release?.()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))

    // then
    expect(drained).toEqual(["session-a"])
    expect(pending.size).toBe(2)
  })

  test("stop is reversible: later schedule calls can re-arm the timer", async () => {
    // given
    const pending = new Set(["session-a"])
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
    scheduler.stop()
    expect(drainSession).not.toHaveBeenCalled()
    pending.add("session-b")
    scheduler.schedule()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))

    // then
    expect(drainSession).toHaveBeenCalled()
    expect(pending.has("session-b")).toBe(false)
    scheduler.dispose()
  })

  test("dispose permanently blocks further scheduling", async () => {
    // given
    const pending = new Set(["session-a"])
    const drainSession = mock(async (sessionID: string) => {
      pending.delete(sessionID)
    })
    const scheduler = createPendingRetryScheduler({
      intervalMs: 10,
      getPendingSessions: () => Array.from(pending),
      drainSession,
    })

    // when
    scheduler.dispose()
    scheduler.schedule()
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))

    // then
    expect(drainSession).not.toHaveBeenCalled()
  })
})
