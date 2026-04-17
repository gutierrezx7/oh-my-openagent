/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { createStreamGeneration } from "./stream-generation"

describe("createStreamGeneration", () => {
  test("captured token stays current until bump replaces it", () => {
    // given
    const generation = createStreamGeneration()
    const token = generation.captureSession("session-a")

    // when
    const beforeBump = generation.isSessionCurrent("session-a", token)
    generation.bumpSession("session-a")
    const afterBump = generation.isSessionCurrent("session-a", token)

    // then
    expect(beforeBump).toBe(true)
    expect(afterBump).toBe(false)
  })

  test("capture after clearSession returns a fresh token so recycled sessions can resume", () => {
    // given
    const generation = createStreamGeneration()
    const before = generation.captureSession("session-a")

    // when
    generation.bumpSession("session-a")
    generation.clearSession("session-a")
    const afterClear = generation.captureSession("session-a")

    // then
    expect(generation.isSessionCurrent("session-a", before)).toBe(false)
    expect(generation.isSessionCurrent("session-a", afterClear)).toBe(true)
  })

  test("captured token before a bump+clear race does not re-match after the clear", () => {
    // given
    const generation = createStreamGeneration()
    const captured = generation.captureSession("session-a")

    // when
    generation.bumpSession("session-a")
    generation.clearSession("session-a")

    // then
    expect(generation.isSessionCurrent("session-a", captured)).toBe(false)
  })

  test("clearSession purges every part token for that session", () => {
    // given
    const generation = createStreamGeneration()
    generation.capturePart("session-a", "part-x")
    generation.capturePart("session-a", "part-y")
    generation.capturePart("session-b", "part-x")

    // when
    generation.clearSession("session-a")

    // then
    expect(generation.size()).toEqual({ sessions: 0, parts: 1 })
  })

  test("clearPart only purges the specified part", () => {
    // given
    const generation = createStreamGeneration()
    generation.capturePart("session-a", "part-x")
    generation.capturePart("session-a", "part-y")

    // when
    generation.clearPart("session-a", "part-x")

    // then
    expect(generation.size()).toEqual({ sessions: 0, parts: 1 })
  })

  test("creating and clearing 1000 session/part pairs leaves size at 0", () => {
    // given
    const generation = createStreamGeneration()

    // when
    for (let i = 0; i < 1000; i++) {
      generation.captureSession(`session-${i}`)
      generation.capturePart(`session-${i}`, `part-a`)
      generation.capturePart(`session-${i}`, `part-b`)
    }
    for (let i = 0; i < 1000; i++) {
      generation.bumpSession(`session-${i}`)
      generation.clearSession(`session-${i}`)
    }

    // then
    expect(generation.size()).toEqual({ sessions: 0, parts: 0 })
  })
})
