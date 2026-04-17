import { log } from "../../shared/logger"

export type PendingRetryScheduler = {
  schedule: () => void
  stop: () => void
  dispose: () => void
}

export type PendingRetrySchedulerOptions = {
  intervalMs: number
  getPendingSessions: () => string[]
  drainSession: (sessionID: string) => Promise<void>
}

export function createPendingRetryScheduler(options: PendingRetrySchedulerOptions): PendingRetryScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  async function run(): Promise<void> {
    timer = undefined
    if (disposed) return
    try {
      const sessions = options.getPendingSessions()
      for (const sessionID of sessions) {
        if (disposed) return
        try {
          await options.drainSession(sessionID)
        } catch (error) {
          log("team session streamer drain session failed", {
            event: "team-mode-session-streamer-drain-error",
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } finally {
      if (!disposed && options.getPendingSessions().length > 0) schedule()
    }
  }

  function schedule(): void {
    if (disposed || timer) return
    timer = setTimeout(() => {
      void run()
    }, options.intervalMs)
  }

  function stop(): void {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  function dispose(): void {
    disposed = true
    stop()
  }

  return { schedule, stop, dispose }
}
