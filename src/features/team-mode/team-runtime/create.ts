import { access, mkdir } from "node:fs/promises"
import path from "node:path"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../../shared/question-denied-session-permission"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import type { BackgroundTask } from "../../background-agent/types"
import type { BackgroundManager } from "../../background-agent/manager"
import type { TmuxSessionManager } from "../../tmux-subagent/manager"
import { ensureTeamMemberFifo } from "../team-layout-tmux/ensure-team-member-fifo"
import { ensureBaseDirs, getInboxDir, getTeamSpecPath, resolveBaseDir } from "../team-registry/paths"
import { createRuntimeState, listActiveTeams, loadRuntimeState, transitionRuntimeState } from "../team-state-store/store"
import type { RuntimeState, TeamSpec } from "../types"
import { activateTeamLayout } from "./activate-team-layout"
import { cleanupTeamRunResources } from "./cleanup-team-run-resources"
import { resolveMember } from "./resolve-member"

const SESSION_ID_POLL_MS = 25

type SpawnedMemberResource = {
  taskId?: string
  worktreePath?: string
}

export class TeamRunCreateError extends Error {
  constructor(
    message: string,
    public readonly cleanupReport: {
      cancelledTaskIds: string[]
      removedLayout: boolean
      removedWorktrees: string[]
      errors: string[]
    },
    cause: Error,
  ) {
    super(`${message}: ${cause.message}`)
    this.name = "TeamRunCreateError"
    this.cause = cause
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveSpecSource(spec: TeamSpec, ctx: ExecutorContext, config: TeamModeConfig): Promise<"project" | "user"> {
  const baseDir = resolveBaseDir(config)
  if (await pathExists(getTeamSpecPath(baseDir, spec.name, "project", ctx.directory))) return "project"
  if (await pathExists(getTeamSpecPath(baseDir, spec.name, "user"))) return "user"
  return "project"
}

async function findExistingRuntime(spec: TeamSpec, leadSessionId: string, config: TeamModeConfig): Promise<RuntimeState | undefined> {
  for (const candidate of await listActiveTeams(config)) {
    if (candidate.teamName !== spec.name || (candidate.status !== "creating" && candidate.status !== "active")) continue
    const runtimeState = await loadRuntimeState(candidate.teamRunId, config).catch(() => undefined)
    if (runtimeState?.leadSessionId === leadSessionId) return runtimeState
  }
}

async function createMemberWorktree(memberWorktreePath: string, projectRoot: string): Promise<string> {
  const absolutePath = path.isAbsolute(memberWorktreePath) ? memberWorktreePath : path.resolve(projectRoot, memberWorktreePath)
  await mkdir(absolutePath, { recursive: true })
  return absolutePath
}

async function waitForTaskSessionId(bgMgr: BackgroundManager, task: BackgroundTask, deadlineAt: number): Promise<string> {
  let sessionId = task.sessionID
  while (!sessionId) {
    if (Date.now() > deadlineAt) throw new Error(`timed out waiting for child session for task ${task.id}`)
    const updatedTask = bgMgr.getTask(task.id)
    if (updatedTask?.status === "error" || updatedTask?.status === "cancelled" || updatedTask?.status === "interrupt") {
      throw new Error(updatedTask.error ?? `task ${task.id} failed before session creation`)
    }
    sessionId = updatedTask?.sessionID
    if (!sessionId) await new Promise((resolve) => setTimeout(resolve, SESSION_ID_POLL_MS))
  }
  return sessionId
}

function buildMemberPrompt(spec: TeamSpec, member: TeamSpec["members"][number], worktreePath?: string): string {
  const promptLines = [`Team: ${spec.name}`, `Member: ${member.name}`]
  if (worktreePath) promptLines.push(`Worktree: ${worktreePath}`)
  if (member.prompt) promptLines.push(member.prompt)
  return promptLines.join("\n")
}

export async function createTeamRun(
  spec: TeamSpec,
  leadSessionId: string,
  ctx: ExecutorContext,
  config: TeamModeConfig,
  bgMgr: BackgroundManager,
  tmuxMgr?: TmuxSessionManager,
): Promise<RuntimeState> {
  const existingRuntime = await findExistingRuntime(spec, leadSessionId, config)
  if (existingRuntime) return existingRuntime

  const baseDir = resolveBaseDir(config)
  await ensureBaseDirs(baseDir)
  const runtimeState = await createRuntimeState(spec, leadSessionId, await resolveSpecSource(spec, ctx, config), config)
  await Promise.all(spec.members.map((member) => mkdir(getInboxDir(baseDir, runtimeState.teamRunId, member.name), { recursive: true })))
  await Promise.all(spec.members.map((member) => ensureTeamMemberFifo(runtimeState.teamRunId, member.name)))

  const deadlineAt = Date.now() + (config.max_wall_clock_minutes * 60_000)
  const resources: SpawnedMemberResource[] = spec.members.map(() => ({}))
  let createdLayout = false

  try {
    let nextMemberIndex = 0
    let failure: Error | undefined
    const workerCount = Math.min(config.max_parallel_members, spec.members.length)
    const categoryExamples = Object.keys(ctx.userCategories ?? {}).join(", ")

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!failure) {
        if (Date.now() > deadlineAt) {
          failure = new Error("team creation exceeded max_wall_clock_minutes")
          return
        }
        const memberIndex = nextMemberIndex++
        const member = spec.members[memberIndex]
        if (!member) return
        const resource = resources[memberIndex]
        if (!resource) return

        try {
          if (member.worktreePath) resource.worktreePath = await createMemberWorktree(member.worktreePath, ctx.directory)
          const resolvedMember = await resolveMember(member, ctx, categoryExamples, spec.leadAgentId)
          const task = await bgMgr.launch({
            description: `Create team member ${spec.name}/${member.name}`,
            prompt: buildMemberPrompt(spec, member, resource.worktreePath),
            agent: resolvedMember.agentToUse,
            parentSessionID: leadSessionId,
            parentMessageID: `team-create:${runtimeState.teamRunId}:${member.name}`,
            model: resolvedMember.model,
            fallbackChain: resolvedMember.fallbackChain,
            skillContent: resolvedMember.systemContent,
            category: member.kind === "category" ? member.category : undefined,
            sessionPermission: QUESTION_DENIED_SESSION_PERMISSION,
          })
          resource.taskId = task.id
          const sessionId = await waitForTaskSessionId(bgMgr, task, deadlineAt)
          await transitionRuntimeState(runtimeState.teamRunId, (currentState) => ({
            ...currentState,
            members: currentState.members.map((currentMember, currentIndex) => currentIndex === memberIndex
              ? { ...currentMember, sessionId, status: "running", worktreePath: resource.worktreePath }
              : currentMember),
          }), config)
        } catch (error) {
          failure = normalizeError(error)
          return
        }
      }
    }))

    if (failure) throw failure

    const launchedRuntimeState = await loadRuntimeState(runtimeState.teamRunId, config)
    createdLayout = await activateTeamLayout(launchedRuntimeState, config, ctx.directory, tmuxMgr)

    return await transitionRuntimeState(runtimeState.teamRunId, (currentState) => ({ ...currentState, status: "active" }), config)
  } catch (error) {
    const cleanupReport = await cleanupTeamRunResources({
      teamRunId: runtimeState.teamRunId,
      config,
      resources,
      bgMgr,
      tmuxMgr,
      createdLayout,
    })
    throw new TeamRunCreateError(`Failed to create team run '${spec.name}'`, cleanupReport, normalizeError(error))
  }
}
