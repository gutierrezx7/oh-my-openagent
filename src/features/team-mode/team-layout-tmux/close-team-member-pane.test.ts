/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test"

import {
  closeTeamMemberPaneWith,
  type CloseTeamMemberPaneDeps,
} from "./close-team-member-pane"

describe("closeTeamMemberPaneWith", () => {
  let sendKeys: CloseTeamMemberPaneDeps["sendKeys"]
  let killPane: CloseTeamMemberPaneDeps["killPane"]
  let delay: CloseTeamMemberPaneDeps["delay"]
  let log: CloseTeamMemberPaneDeps["log"]
  let calls: Array<string>

  beforeEach(() => {
    calls = []
    sendKeys = mock(async (paneId: string, keys: string): Promise<void> => {
      calls.push(`sendKeys:${paneId}:${keys}`)
    })
    killPane = mock(async (paneId: string): Promise<{ success: boolean; stderr: string }> => {
      calls.push(`killPane:${paneId}`)
      return { success: true, stderr: "" }
    })
    delay = mock(async (milliseconds: number): Promise<void> => {
      calls.push(`delay:${milliseconds}`)
    })
    log = mock((): void => undefined)
  })

  it("#given healthy pane #when close #then sends C-c, waits 250ms, then kill-pane, returns true", async () => {
    // given
    const deps: CloseTeamMemberPaneDeps = { sendKeys, killPane, delay, log }

    // when
    const result = await closeTeamMemberPaneWith("%42", deps)

    // then
    expect(result).toBe(true)
    expect(calls).toEqual(["sendKeys:%42:C-c", "delay:250", "killPane:%42"])
  })

  it("#given pane already closed by C-c #when kill-pane errors with 'can't find pane' #then returns true", async () => {
    // given
    killPane = mock(async (paneId: string): Promise<{ success: boolean; stderr: string }> => {
      calls.push(`killPane:${paneId}`)
      return { success: false, stderr: "can't find pane: %42" }
    })

    const deps: CloseTeamMemberPaneDeps = { sendKeys, killPane, delay, log }

    // when
    const result = await closeTeamMemberPaneWith("%42", deps)

    // then
    expect(result).toBe(true)
  })

  it("#given kill-pane fails with other stderr #when close #then returns false and logs", async () => {
    // given
    killPane = mock(async (paneId: string): Promise<{ success: boolean; stderr: string }> => {
      calls.push(`killPane:${paneId}`)
      return { success: false, stderr: "permission denied" }
    })

    const deps: CloseTeamMemberPaneDeps = { sendKeys, killPane, delay, log }

    // when
    const result = await closeTeamMemberPaneWith("%42", deps)

    // then
    expect(result).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it("#given empty paneId #when close #then returns false without calling tmux", async () => {
    // given
    const deps: CloseTeamMemberPaneDeps = { sendKeys, killPane, delay, log }

    // when
    const result = await closeTeamMemberPaneWith("", deps)

    // then
    expect(result).toBe(false)
    expect(sendKeys).toHaveBeenCalledTimes(0)
    expect(killPane).toHaveBeenCalledTimes(0)
    expect(delay).toHaveBeenCalledTimes(0)
  })
})
