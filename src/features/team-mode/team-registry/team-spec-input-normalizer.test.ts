/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"

import { resolveCallerTeamLead } from "../resolve-caller-team-lead"
import { normalizeTeamSpecInput } from "./team-spec-input-normalizer"

describe("normalizeTeamSpecInput", () => {
  test("injects the caller as lead when no lead is specified", () => {
    // given
    const rawSpec = {
      name: "alpha-team",
      members: [{ kind: "category", category: "quick", prompt: "Inspect the workspace" }],
    }

    // when
    const normalizedSpec = normalizeTeamSpecInput(rawSpec, {
      callerTeamLead: resolveCallerTeamLead("\u200BSisyphus - Ultraworker"),
    })

    // then
    expect(normalizedSpec).toMatchObject({
      leadAgentId: "lead",
      members: [
        { name: "lead", kind: "subagent_type", subagent_type: "sisyphus" },
        { name: "quick-1", kind: "category", category: "quick" },
      ],
    })
  })

  test("keeps an explicit leadAgentId unchanged when the caller is eligible", () => {
    // given
    const rawSpec = {
      name: "alpha-team",
      leadAgentId: "captain",
      members: [
        { kind: "subagent_type", name: "captain", subagent_type: "atlas" },
        { kind: "category", name: "member-1", category: "quick", prompt: "Inspect the workspace" },
      ],
    }

    // when
    const normalizedSpec = normalizeTeamSpecInput(rawSpec, {
      callerTeamLead: resolveCallerTeamLead("Sisyphus - Ultraworker"),
    })

    // then
    expect(normalizedSpec).toEqual(rawSpec)
  })

  test("prefers isLead over the caller when both are present", () => {
    // given
    const rawSpec = {
      name: "alpha-team",
      members: [
        { kind: "subagent_type", name: "captain", subagent_type: "atlas", isLead: true },
        { kind: "category", category: "quick", prompt: "Inspect the workspace" },
      ],
    }

    // when
    const normalizedSpec = normalizeTeamSpecInput(rawSpec, {
      callerTeamLead: resolveCallerTeamLead("Sisyphus - Ultraworker"),
    })

    // then
    expect(normalizedSpec).toMatchObject({
      leadAgentId: "captain",
      members: [
        { kind: "subagent_type", name: "captain", subagent_type: "atlas" },
        { kind: "category", name: "quick-1", category: "quick" },
      ],
    })
  })

  test("throws a clear error when the caller is not eligible and no lead is specified", () => {
    // given
    const rawSpec = {
      name: "alpha-team",
      members: [{ kind: "category", category: "quick", prompt: "Inspect the workspace" }],
    }

    // when
    const result = () => normalizeTeamSpecInput(rawSpec, {
      callerTeamLead: resolveCallerTeamLead("explore"),
    })

    // then
    expect(result).toThrow("Caller agent explore is not eligible as team lead; specify leadAgentId explicitly")
  })
})
