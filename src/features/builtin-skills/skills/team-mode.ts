import type { BuiltinSkill } from "../types"

export const teamModeSkill: BuiltinSkill = {
  name: "team-mode",
  description:
    "Team orchestration — create and manage parallel agent teams (OFF by default; enable via team_mode.enabled in config). Loading this skill provides usage documentation; the team_* tools are registered globally when team_mode.enabled=true and access-gated by team role.",
  template: `# Team Mode (placeholder)

Usage documentation will be filled in by Task 26.

This skill is a documentation-only surface. The 12 team_* tools are registered via the plugin ToolRegistry when team_mode.enabled=true. Access is gated by the teamToolGating hook based on lead/member/neither role.`,
}
