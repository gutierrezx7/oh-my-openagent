export type RebalanceLayout = "main-vertical" | "tiled"

export type RebalanceTeamWindowDeps = {
  runTmux: (args: string[]) => Promise<{ success: boolean }>
  log: (message: string, meta?: Record<string, unknown>) => void
}

export async function rebalanceTeamWindowWith(
  windowId: string,
  layout: RebalanceLayout,
  deps: RebalanceTeamWindowDeps,
): Promise<boolean> {
  if (windowId.length === 0) {
    return false
  }

  const selectLayoutArgs = ["select-layout", "-t", windowId, layout]
  const initialLayout = await deps.runTmux(selectLayoutArgs)
  if (!initialLayout.success) {
    deps.log("[rebalanceTeamWindow] FAILED", { windowId, layout, step: "select-layout" })
    return false
  }

  if (layout === "tiled") {
    return true
  }

  const setMainPaneWidth = await deps.runTmux([
    "set-window-option",
    "-t",
    windowId,
    "main-pane-width",
    "60%",
  ])
  if (!setMainPaneWidth.success) {
    deps.log("[rebalanceTeamWindow] FAILED", { windowId, layout, step: "set-window-option" })
    return false
  }

  const finalLayout = await deps.runTmux(selectLayoutArgs)
  if (!finalLayout.success) {
    deps.log("[rebalanceTeamWindow] FAILED", { windowId, layout, step: "select-layout" })
    return false
  }

  return true
}

export async function rebalanceTeamWindow(
  windowId: string,
  layout: RebalanceLayout,
): Promise<boolean> {
  const [{ log }, { getTmuxPath }, { runTmuxCommand }] = await Promise.all([
    import("../../../shared"),
    import("../../../tools/interactive-bash/tmux-path-resolver"),
    import("./tmux-runner"),
  ])

  const tmuxPath = await getTmuxPath()
  if (!tmuxPath) {
    log("[rebalanceTeamWindow] SKIP: tmux not found", { windowId, layout })
    return false
  }

  return rebalanceTeamWindowWith(windowId, layout, {
    runTmux: async (args: string[]): Promise<{ success: boolean }> => runTmuxCommand(tmuxPath, args),
    log,
  })
}
