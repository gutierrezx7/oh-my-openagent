import { describe, expect, test } from "bun:test"

import { createBuiltinSkills } from "../skills"
import { teamModeSkill } from "./team-mode"

describe("teamModeSkill gating", () => {
  test("team-mode hidden when disabled", () => {
    // given
    const options = {
      teamModeEnabled: false,
      disabledSkills: new Set<string>(),
    }

    // when
    const skills = createBuiltinSkills(options)

    // then
    expect(skills.some((skill) => skill.name === "team-mode")).toBe(false)
  })

  test("team-mode visible when enabled", () => {
    // given
    const options = {
      teamModeEnabled: true,
      disabledSkills: new Set<string>(),
    }

    // when
    const skills = createBuiltinSkills(options)

    // then
    const skill = skills.find((candidateSkill) => candidateSkill.name === "team-mode")
    expect(skill).toBeDefined()
    expect(skill?.name).toBe("team-mode")
    expect(skill?.description).toBe(teamModeSkill.description)
  })

  test("team-mode skill has no mcpConfig", () => {
    // given

    // when
    const skill = teamModeSkill

    // then
    expect(skill.mcpConfig).toBeUndefined()
  })

  test("team-mode skill body keeps required keywords", () => {
    // given
    const body = teamModeSkill.template

    // when
    const keywords = [
      "TeamSpec",
      "member",
      "category",
      "subagent_type",
      "sisyphus",
      "atlas",
      "hephaestus",
      "oracle",
      "eligible",
    ]

    // then
    for (const keyword of keywords) {
      expect(body).toContain(keyword)
    }
  })
})
