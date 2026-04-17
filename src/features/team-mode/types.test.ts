import { describe, expect, test } from "bun:test"
import {
  AGENT_ELIGIBILITY_REGISTRY,
  CategoryMemberSchema,
  MemberSchema,
  parseMember,
  SubagentMemberSchema,
} from "./types"

describe("team-mode types", () => {
  test("member category branch parses and narrows", () => {
    // given
    const member = { kind: "category", name: "m1", category: "deep", prompt: "impl X" }

    // when
    const result = MemberSchema.safeParse(member)

    // then
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toMatchObject(member)
      expect(result.data).toMatchObject({ kind: "category", category: "deep" })
    }
  })

  test("both kinds rejected", () => {
    // given
    const member = {
      kind: "category",
      name: "m1",
      category: "deep",
      subagent_type: "sisyphus",
      prompt: "impl X",
    }

    // when
    const result = MemberSchema.safeParse(member)

    // then
    expect(result.success).toBe(false)
  })

  test("parseMember emits exact both kinds error", () => {
    // given
    const member = {
      name: "m1",
      kind: "category",
      category: "deep",
      subagent_type: "sisyphus",
      prompt: "impl X",
    }

    // when
    try {
      parseMember(member)
    } catch (error) {
      // then
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "Member 'm1' specifies both 'category' and 'subagent_type'. Must specify exactly one via 'kind' discriminator.",
      )
    }
  })

  test("parseMember emits exact missing kind error", () => {
    // given
    const member = { name: "m1" }

    // when
    try {
      parseMember(member)
    } catch (error) {
      // then
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "Member 'm1' missing 'kind' discriminator. Specify either {kind:'category', category, prompt} or {kind:'subagent_type', subagent_type}.",
      )
    }
  })

  test("parseMember emits exact category missing prompt error", () => {
    // given
    const member = { name: "m1", kind: "category", category: "deep" }

    // when
    try {
      parseMember(member)
    } catch (error) {
      // then
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "Member 'm1' uses category 'deep' but is missing required 'prompt' field. Category members must supply a task prompt.",
      )
    }
  })

  test("parseMember emits exact unknown subagent error", () => {
    // given
    const member = { name: "m1", kind: "subagent_type", subagent_type: "foobar" }

    // when
    try {
      parseMember(member)
    } catch (error) {
      // then
      expect(error instanceof Error ? error.message : String(error)).toBe(
        "Unknown subagent_type 'foobar'. Available ELIGIBLE agents: sisyphus, atlas, sisyphus-junior, hephaestus (if D-36 applied). Use delegate-task for read-only agents like oracle, librarian, explore, metis, momus, multimodal-looker.",
      )
    }
  })

  test("parseMember returns valid category member", () => {
    // given
    const member = { name: "m1", kind: "category", category: "deep", prompt: "impl X" }

    // when
    const result = parseMember(member)

    // then
    expect(result).toMatchObject(member)
  })

  test("parseMember returns valid subagent member", () => {
    // given
    const member = { name: "m1", kind: "subagent_type", subagent_type: "sisyphus" }

    // when
    const result = parseMember(member)

    // then
    expect(result).toMatchObject(member)
  })

  test("category requires prompt", () => {
    // given
    const member = { kind: "category", name: "m1", category: "deep" }

    // when
    const result = CategoryMemberSchema.safeParse(member)

    // then
    expect(result.success).toBe(false)
  })

  test("eligibility registry shape", () => {
    // given
    const entries = Object.entries(AGENT_ELIGIBILITY_REGISTRY)

    // when
    const verdictCounts = entries.reduce(
      (counts, [, value]) => {
        counts[value.verdict] += 1
        return counts
      },
      { eligible: 0, conditional: 0, "hard-reject": 0 },
    )

    // then
    expect(entries).toHaveLength(11)
    expect(verdictCounts).toEqual({ eligible: 3, conditional: 1, "hard-reject": 7 })
    expect(AGENT_ELIGIBILITY_REGISTRY.hephaestus.rejectionMessage).toBe(
      "Agent 'hephaestus' lacks teammate permission. Either apply D-36 (add teammate: \"allow\" in tool-config-handler.ts) or use subagent_type: \"sisyphus\" instead.",
    )
    expect(AGENT_ELIGIBILITY_REGISTRY.oracle.rejectionMessage).toBe(
      "Agent 'oracle' is read-only (cannot write files). Team members must write to mailbox inbox files. Use delegate-task with subagent_type: 'oracle' for read-only analysis instead.",
    )
    expect(AGENT_ELIGIBILITY_REGISTRY.librarian.rejectionMessage).toBe(
      "Agent 'librarian' is read-only (write/edit denied). Cannot write to mailbox as team member. Use delegate-task for research queries instead.",
    )
    expect(AGENT_ELIGIBILITY_REGISTRY.explore.rejectionMessage).toBe(
      "Agent 'explore' is read-only (write/edit denied). Cannot write to mailbox as team member. Use delegate-task for codebase exploration instead.",
    )
    expect(AGENT_ELIGIBILITY_REGISTRY["multimodal-looker"].rejectionMessage).toBe(
      "Agent 'multimodal-looker' has read-only tool access (only 'read' allowed). Cannot write to mailbox as team member.",
    )
    expect(AGENT_ELIGIBILITY_REGISTRY.metis.rejectionMessage).toBe(
      "Agent 'metis' is read-only (pre-planning consultant). Cannot write to mailbox as team member. Use delegate-task for pre-planning analysis instead.",
    )
    expect(AGENT_ELIGIBILITY_REGISTRY.momus.rejectionMessage).toBe(
      "Agent 'momus' is read-only (plan reviewer). Cannot write to mailbox as team member. Use delegate-task for plan review instead.",
    )
    expect(AGENT_ELIGIBILITY_REGISTRY.prometheus.rejectionMessage).toBe(
      "Agent 'prometheus' is plan-mode-only; can only write to .sisyphus/*.md (enforced by prometheusMdOnly hook). Cannot write to team mailbox. Use category: 'plan' instead.",
    )
    expect(CategoryMemberSchema).toBeDefined()
    expect(SubagentMemberSchema).toBeDefined()
  })
})
