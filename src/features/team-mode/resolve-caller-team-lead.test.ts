/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { resolveCallerTeamLead } from "./resolve-caller-team-lead"

describe("resolveCallerTeamLead", () => {
  test("returns an eligible sisyphus lead for the plain display name", () => {
    // given
    const rawAgentName = "Sisyphus"

    // when
    const result = resolveCallerTeamLead(rawAgentName)

    // then
    expect(result).toEqual({
      agentTypeId: "sisyphus",
      displayName: "Sisyphus",
      isEligibleForTeamLead: true,
    })
  })

  test("returns an eligible sisyphus lead for the suffixed display name", () => {
    // given
    const rawAgentName = "Sisyphus - Ultraworker"

    // when
    const result = resolveCallerTeamLead(rawAgentName)

    // then
    expect(result).toEqual({
      agentTypeId: "sisyphus",
      displayName: "Sisyphus - Ultraworker",
      isEligibleForTeamLead: true,
    })
  })

  test("strips visible ordering prefixes before resolving the caller lead", () => {
    // given
    const rawAgentName = "00|Sisyphus"

    // when
    const result = resolveCallerTeamLead(rawAgentName)

    // then
    expect(result).toEqual({
      agentTypeId: "sisyphus",
      displayName: "Sisyphus",
      isEligibleForTeamLead: true,
    })
  })

  test("returns not eligible when the caller agent is undefined", () => {
    // given
    const rawAgentName = undefined

    // when
    const result = resolveCallerTeamLead(rawAgentName)

    // then
    expect(result).toEqual({ isEligibleForTeamLead: false })
  })

  test("returns not eligible for read-only agents", () => {
    // given
    const rawAgentName = "Oracle"

    // when
    const result = resolveCallerTeamLead(rawAgentName)

    // then
    expect(result).toEqual({
      displayName: "Oracle",
      isEligibleForTeamLead: false,
    })
  })
})
