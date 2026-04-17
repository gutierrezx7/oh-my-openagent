import { spawn } from "bun"

export type TmuxCommandResult = { success: boolean; output: string }

export async function runTmuxCommand(tmuxPath: string, args: Array<string>): Promise<TmuxCommandResult> {
  const proc = spawn([tmuxPath, ...args], { stdout: "pipe", stderr: "pipe" })
  const outputPromise = new Response(proc.stdout).text()
  const exitCode = await proc.exited
  const output = await outputPromise
  return exitCode === 0 ? { success: true, output: output.trim() } : { success: false, output: output.trim() }
}
