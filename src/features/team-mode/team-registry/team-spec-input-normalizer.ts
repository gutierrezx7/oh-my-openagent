type JsonRecord = Record<string, unknown>

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

export function normalizeTeamSpecInput(raw: unknown): unknown {
  if (!isJsonRecord(raw)) {
    return raw
  }

  const normalizedSpec = cloneJsonRecord(raw)
  const rawMembers = raw.members
  const rawLead = raw.lead
  let leadAgentId = typeof raw.leadAgentId === "string" ? raw.leadAgentId : undefined

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
