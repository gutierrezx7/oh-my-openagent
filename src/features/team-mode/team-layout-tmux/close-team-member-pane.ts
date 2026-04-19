/// <reference types="bun-types" />

import { spawn } from "bun"

export type CloseTeamMemberPaneDeps = {
  sendKeys: (paneId: string, keys: string) => Promise<void>
  killPane: (paneId: string) => Promise<{ success: boolean; stderr: string }>
  delay: (milliseconds: number) => Promise<void>
  log: (message: string, meta?: Record<string, unknown>) => void
}

export async function closeTeamMemberPaneWith(
  paneId: string,
  deps: CloseTeamMemberPaneDeps,
): Promise<boolean> {
  if (paneId.length === 0) {
    return false
  }

  try {
    await deps.sendKeys(paneId, "C-c")
    await deps.delay(250)

    const result = await deps.killPane(paneId)
    if (result.success) {
      return true
    }

    const trimmedStderr = result.stderr.trim()
    if (/can't find pane/i.test(trimmedStderr)) {
      return true
    }

    deps.log("[closeTeamMemberPane] FAILED", { paneId, stderr: trimmedStderr })
    return false
  } catch (error) {
    deps.log("[closeTeamMemberPane] FAILED", {
      paneId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export async function closeTeamMemberPane(paneId: string): Promise<boolean> {
  const [{ log }, { getTmuxPath }] = await Promise.all([
    import("../../../shared"),
    import("../../../tools/interactive-bash/tmux-path-resolver"),
  ])

  const tmuxPath = await getTmuxPath()
  if (!tmuxPath) {
    log("[closeTeamMemberPane] SKIP: tmux not found")
    return false
  }

  const deps: CloseTeamMemberPaneDeps = {
    async sendKeys(targetPaneId: string, keys: string): Promise<void> {
      const process = spawn([tmuxPath, "send-keys", "-t", targetPaneId, keys], {
        stdout: "ignore",
        stderr: "ignore",
      })

      await process.exited
    },
    async killPane(targetPaneId: string): Promise<{ success: boolean; stderr: string }> {
      const process = spawn([tmuxPath, "kill-pane", "-t", targetPaneId], {
        stdout: "ignore",
        stderr: "pipe",
      })
      const stderr = process.stderr ? await new Response(process.stderr).text() : ""
      const exitCode = await process.exited
      return { success: exitCode === 0, stderr: stderr.trim() }
    },
    async delay(milliseconds: number): Promise<void> {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds)
      })
    },
    log,
  }

  return closeTeamMemberPaneWith(paneId, deps)
}
