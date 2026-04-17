import { log } from "../../shared/logger"

export type PendingRetryScheduler = {
  schedule: () => void
  stop: () => void
}

export type PendingRetrySchedulerOptions = {
  intervalMs: number
  getPendingSessions: () => string[]
  drainSession: (sessionID: string) => Promise<void>
}

export function createPendingRetryScheduler(options: PendingRetrySchedulerOptions): PendingRetryScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  async function run(): Promise<void> {
    timer = undefined
    if (stopped) return
    try {
      const sessions = options.getPendingSessions()
      for (const sessionID of sessions) {
        if (stopped) return
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
      if (!stopped && options.getPendingSessions().length > 0) schedule()
    }
  }

  function schedule(): void {
    if (stopped || timer) return
    timer = setTimeout(() => {
      void run()
    }, options.intervalMs)
  }

  function stop(): void {
    stopped = true
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  return { schedule, stop }
}
