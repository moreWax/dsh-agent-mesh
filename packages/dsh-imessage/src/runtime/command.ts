import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

export interface CommandRequest { command: string; args: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal; input?: string }
export interface CommandResult { stdout: string; stderr: string }
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>

/** No shell, no inherited secret arguments, bounded output, and abort support. */
export const runCommand: CommandRunner = async request => {
  const result = await execute(request.command, request.args, {
    shell: false, windowsHide: true, timeout: request.timeoutMs ?? 15_000,
    maxBuffer: 1024 * 1024, env: request.env ?? process.env, signal: request.signal,
    ...(request.input === undefined ? {} : { input: request.input }),
  })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}
