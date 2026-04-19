import type { CallerTeamLead } from "../resolve-caller-team-lead"

type JsonRecord = Record<string, unknown>

export type NormalizeTeamSpecInputOptions = {
  callerTeamLead?: CallerTeamLead
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function cloneJsonRecord(value: JsonRecord): JsonRecord {
  return { ...value }
}

function getMemberName(value: unknown): string | undefined {
  return isJsonRecord(value) && typeof value.name === "string" ? value.name : undefined
}

function normalizeMemberNameStem(value: string): string {
  const normalizedStem = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return normalizedStem.length > 0 ? normalizedStem : "member"
}

function deriveMemberNameStem(member: JsonRecord): string {
  if (member.kind === "category" && typeof member.category === "string") {
    return normalizeMemberNameStem(member.category)
  }

  if (member.kind === "subagent_type" && typeof member.subagent_type === "string") {
    return normalizeMemberNameStem(member.subagent_type)
  }

  return "member"
}

function assignGeneratedMemberNames(rawMembers: unknown[]): unknown[] {
  const usedNames = new Set(rawMembers.flatMap((member) => {
    const memberName = getMemberName(member)
    return memberName === undefined ? [] : [memberName]
  }))

  return rawMembers.map((member) => {
    if (!isJsonRecord(member) || getMemberName(member) !== undefined) {
      return member
    }

    const stem = deriveMemberNameStem(member)
    let suffix = 1
    let generatedName = `${stem}-${suffix}`
    while (usedNames.has(generatedName)) {
      suffix += 1
      generatedName = `${stem}-${suffix}`
    }

    usedNames.add(generatedName)
    return { ...member, name: generatedName }
  })
}

function stripMemberLeadFlag(value: unknown): unknown {
  if (!isJsonRecord(value) || !Object.hasOwn(value, "isLead")) {
    return value
  }

  const { isLead: _isLead, ...memberWithoutLeadFlag } = value
  return memberWithoutLeadFlag
}

function hasMemberLeadFlag(rawMembers: unknown[]): boolean {
  return rawMembers.some((member) => isJsonRecord(member) && member.isLead === true)
}

function createCallerLeadMember(callerAgentTypeId: string): JsonRecord {
  return {
    name: "lead",
    kind: "subagent_type",
    subagent_type: callerAgentTypeId,
  }
}

export function normalizeTeamSpecInput(raw: unknown, options?: NormalizeTeamSpecInputOptions): unknown {
  if (!isJsonRecord(raw)) {
    return raw
  }

  const normalizedSpec = cloneJsonRecord(raw)
  const rawMembers = raw.members
  const rawLead = raw.lead
  let leadAgentId = typeof raw.leadAgentId === "string" ? raw.leadAgentId : undefined
  const hasExplicitLead = leadAgentId !== undefined
    || isJsonRecord(rawLead)
    || (Array.isArray(rawMembers) && hasMemberLeadFlag(rawMembers))

  if (Array.isArray(rawMembers)) {
    let normalizedMembers = rawMembers.map((member) => isJsonRecord(member) ? cloneJsonRecord(member) : member)

    if (isJsonRecord(rawLead)) {
      const leadMember = cloneJsonRecord(rawLead)
      if (leadMember.name === undefined) {
        leadMember.name = "lead"
      }

      const leadName = getMemberName(leadMember)
      const alreadyPresent = leadName !== undefined && normalizedMembers.some((member) => getMemberName(member) === leadName)
      if (!alreadyPresent) {
        normalizedMembers = [leadMember, ...normalizedMembers]
      }

      if (leadAgentId === undefined && leadName !== undefined) {
        leadAgentId = leadName
      }
    }

    if (!hasExplicitLead) {
      const callerTeamLead = options?.callerTeamLead
      if (callerTeamLead?.isEligibleForTeamLead && callerTeamLead.agentTypeId !== undefined) {
        normalizedMembers = [createCallerLeadMember(callerTeamLead.agentTypeId), ...normalizedMembers]
        leadAgentId = "lead"
      } else if (callerTeamLead?.displayName !== undefined) {
        throw new Error(`Caller agent ${callerTeamLead.displayName} is not eligible as team lead; specify leadAgentId explicitly`)
      }
    }

    normalizedMembers = assignGeneratedMemberNames(normalizedMembers)

    normalizedMembers = normalizedMembers.map((member) => {
      const memberName = getMemberName(member)
      const isLead = isJsonRecord(member) && member.isLead === true
      if (leadAgentId === undefined && isLead && memberName !== undefined) {
        leadAgentId = memberName
      }
      return stripMemberLeadFlag(member)
    })

    if (leadAgentId === undefined && normalizedMembers.length === 1) {
      leadAgentId = getMemberName(normalizedMembers[0])
    }

    normalizedSpec.members = normalizedMembers
  }

  if (leadAgentId !== undefined) {
    normalizedSpec.leadAgentId = leadAgentId
  }

  delete normalizedSpec.lead

  return normalizedSpec
}
