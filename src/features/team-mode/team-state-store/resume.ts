import { rm, stat } from "node:fs/promises"

import type { TeamModeConfig } from "../../../config/schema/team-mode"
import { log } from "../../../shared/logger"
import type { ExecutorContext } from "../../../tools/delegate-task/executor-types"
import { getRuntimeStateDir, resolveBaseDir } from "../team-registry/paths"
import type { RuntimeState } from "../types"
import { listActiveTeams, loadRuntimeState, transitionRuntimeState } from "./store"

const CREATING_TIMEOUT_MS = 30 * 60 * 1000

export interface ResumeReport {
  resumed: number
  marked_failed: number
  marked_orphaned: number
  cleaned: number
  errors: Error[]
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function extractErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (typeof error !== "object" || error === null || !("message" in error)) return undefined
  return typeof error.message === "string" ? error.message : undefined
}

function extractErrorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined
  return typeof error.status === "number" ? error.status : undefined
}

function isSessionNotFoundError(error: unknown): boolean {
  if (extractErrorStatus(error) === 404) return true
  const message = extractErrorMessage(error)?.toLowerCase()
  return message?.includes("not found") === true || message?.includes("missing") === true
}

async function runtimeDirectoryExists(teamRunId: string, config: TeamModeConfig): Promise<boolean> {
  try {
    await stat(getRuntimeStateDir(resolveBaseDir(config), teamRunId))
    return true
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError.code === "ENOENT") return false
    throw error
  }
}

async function removeRuntimeDirectory(teamRunId: string, config: TeamModeConfig): Promise<boolean> {
  if (!(await runtimeDirectoryExists(teamRunId, config))) return false
  await rm(getRuntimeStateDir(resolveBaseDir(config), teamRunId), { recursive: true, force: true })
  return true
}

async function cleanupMemberWorktrees(runtimeState: RuntimeState): Promise<void> {
  await Promise.all(runtimeState.members.map(async (member) => {
    if (!member.worktreePath) return
    await rm(member.worktreePath, { recursive: true, force: true })
  }))
}

async function leadSessionExists(
  ctx: ExecutorContext,
  leadSessionId: string,
): Promise<boolean> {
  try {
    const response = await ctx.client.session.get({ path: { id: leadSessionId } })

    if (response.error !== undefined && response.error !== null) {
      if (isSessionNotFoundError(response.error)) return false
      throw toError(response.error)
    }

    return response.data != null
  } catch (error) {
    if (isSessionNotFoundError(error)) return false
    throw error
  }
}

function isCreatingStateStuck(runtimeState: RuntimeState, now: number): boolean {
  return runtimeState.status === "creating" && now - runtimeState.createdAt > CREATING_TIMEOUT_MS
}

export async function resumeAllTeams(
  ctx: ExecutorContext,
  config: TeamModeConfig,
): Promise<ResumeReport> {
  const report: ResumeReport = {
    resumed: 0,
    marked_failed: 0,
    marked_orphaned: 0,
    cleaned: 0,
    errors: [],
  }
  const now = Date.now()
  const activeTeams = await listActiveTeams(config)

  for (const activeTeam of activeTeams) {
    try {
      const runtimeState = await loadRuntimeState(activeTeam.teamRunId, config)

      switch (runtimeState.status) {
        case "creating": {
          if (!isCreatingStateStuck(runtimeState, now)) break
          await cleanupMemberWorktrees(runtimeState)
          await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
            ...currentRuntimeState,
            status: "failed",
          }), config)
          report.marked_failed += 1
          break
        }

        case "active": {
          if (!runtimeState.leadSessionId || !(await leadSessionExists(ctx, runtimeState.leadSessionId))) {
            await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
              ...currentRuntimeState,
              status: "orphaned",
            }), config)
            report.marked_orphaned += 1
            break
          }

          report.resumed += 1
          break
        }

        case "shutdown_requested": {
          break
        }

        case "deleting": {
          await cleanupMemberWorktrees(runtimeState)
          await transitionRuntimeState(runtimeState.teamRunId, (currentRuntimeState) => ({
            ...currentRuntimeState,
            status: "deleted",
          }), config)
          if (await removeRuntimeDirectory(runtimeState.teamRunId, config)) {
            report.cleaned += 1
          }
          break
        }

        case "deleted":
        case "failed": {
          if (await removeRuntimeDirectory(runtimeState.teamRunId, config)) {
            report.cleaned += 1
          }
          break
        }

        case "orphaned": {
          break
        }
      }
    } catch (error) {
      const resumeError = toError(error)
      report.errors.push(resumeError)
      log("team runtime resume failed", {
        event: "team-runtime-resume-failed",
        teamRunId: activeTeam.teamRunId,
        teamName: activeTeam.teamName,
        status: activeTeam.status,
        error: resumeError.message,
      })
    }
  }

  return report
}
