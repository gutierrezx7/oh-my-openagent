import type { BuiltinSkill } from "../types"

export const teamModeSkill: BuiltinSkill = {
  name: "team-mode",
  description:
    "Team orchestration — create and manage parallel agent teams (OFF by default; enable via team_mode.enabled in config). Loading this skill provides usage documentation; the team_* tools are registered globally when team_mode.enabled=true and access-gated by team role.",
  template: `# Team Mode

Team mode gives Claude Code Agent Teams parity. It is off by default. Enable it only when you want parallel multi-agent coordination, where each team member is an opencode child session.

## When to use

- Split a large job across several agents.
- Keep a lead agent focused while member agents work in parallel.
- Use worktree mode for isolated code changes, or tmux visualization when you want live session layout.

## Declare a team

Create a team at \`~/.omo/teams/{name}/config.json\`.

This TeamSpec uses a lead plus members list.

Example:

\`\`\`json
{
  "name": "release-squad",
  "lead": {
    "kind": "subagent_type",
    "subagent_type": "sisyphus"
  },
  "members": [
    {
      "kind": "category",
      "category": "quick",
      "prompt": "review small changes and report risks"
    },
    {
      "kind": "subagent_type",
      "subagent_type": "atlas"
    }
  ]
}
\`\`\`

## Member schema

Use \`kind: "category"\` when you want a category-backed worker. It must include both \`category\` and \`prompt\`. D-40: category members always route through \`sisyphus-junior\`.

Use \`kind: "subagent_type"\` only for eligible agents.

### Eligible subagent types

- \`sisyphus\`
- \`atlas\`
- \`sisyphus-junior\`
- \`hephaestus\`

### Hard rejects

Do not use \`oracle\`, \`prometheus\`, or other non-eligible agents here. For those, use \`delegate-task\` instead.

## Lifecycle

1. Create the team with \`team_create\`.
2. Send work with \`team_send_message\` or create tasks with \`team_task_create\`.
3. Track progress with \`team_task_list\`, \`team_task_get\`, \`team_task_update\`, \`team_status\`, and \`team_list\`.
4. Request shutdown with \`team_shutdown_request\`.
5. Approve or reject with \`team_approve_shutdown\` or \`team_reject_shutdown\`.
6. Delete the team with \`team_delete\`.

## Tool reference

- \`team_create\` - create a team from a declaration.
- \`team_delete\` - remove a team.
- \`team_shutdown_request\` - ask the lead to wind down.
- \`team_approve_shutdown\` - approve shutdown.
- \`team_reject_shutdown\` - reject shutdown.
- \`team_send_message\` - broadcast or direct a message.
- \`team_task_create\` - create a task for a member.
- \`team_task_list\` - list team tasks.
- \`team_task_update\` - update task state.
- \`team_task_get\` - inspect one task.
- \`team_status\` - show live team status.
- \`team_list\` - list teams.

## Bounds

- Max 8 members.
- Max 4 parallel workers.
- Max 32KB per message.
- Max 256KB unread inbox.

## Failure modes

- Broadcast is lead-only.
- No nested teams.
- No peer sync wait; work moves asynchronously.

## Notes

Team mode is a docs-only skill. The team_* tools are registered globally when \`team_mode.enabled=true\`.
Use \`~/.omo/teams/{name}/config.json\` plus worktree or tmux visibility to understand how the team is laid out.
`,
}
