/**
 * Operator remote execution: peer_exec runs a bounded shell command on THIS
 * machine, gated by the caller presenting THIS fleet member's own capability.
 * Trust math: the member's capability is known only to the member (its dsh)
 * and the operator (the registry) — so the operator can drive members and no
 * member can drive another. Every call lands in the audit stream (and thus
 * the fleet channel) — the member can always see what the operator ran.
 */
import { execFile } from 'node:child_process'
import type { ToolDescriptor } from './tools.js'
import { TaskProtocolError, type JsonObject } from './types.js'

const MAX_OUTPUT = 8 * 1024
const truncate = (text: string): string => text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + `\n…(truncated at ${MAX_OUTPUT} bytes)` : text

export interface PeerExecResult { exit: number | null; stdout: string; stderr: string; timedOut: boolean }

export async function runPeerExec(command: string, timeoutMs: number): Promise<PeerExecResult> {
  return new Promise((resolve) => {
    const child = execFile('/bin/sh', ['-c', command], { timeout: timeoutMs, maxBuffer: 4 * MAX_OUTPUT, env: { ...process.env } }, (error, stdout, stderr) => {
      const timedOut = error != null && (error as { killed?: boolean }).killed === true
      resolve({
        exit: typeof (error as { code?: unknown } | null)?.code === 'number' ? (error as { code: number }).code : error == null ? 0 : null,
        stdout: truncate(String(stdout ?? '')),
        stderr: truncate(String(stderr ?? '')),
        timedOut,
      })
    })
    child.on('error', (spawnError) => resolve({ exit: null, stdout: '', stderr: String(spawnError), timedOut: false }))
  })
}

export function peerExecTools(options: { enabled?: boolean; timeoutMs?: number } = {}): ToolDescriptor[] {
  if (options.enabled === false) return []
  const timeoutCap = options.timeoutMs ?? 30_000
  return [
    { name: 'peer_exec', description: 'Run a bounded shell command on this machine (operator-only in practice: requires THIS member\'s capability, which only the member and the operator hold). Every call is audited.',
      auth: 'capability', requiredScopes: ['tasks'],
      schema: { type: 'object', required: ['command'], properties: { command: { type: 'string', minLength: 1 }, timeoutMs: { type: 'number' } }, additionalProperties: false },
      handler: async (args: JsonObject) => {
        const command = typeof args.command === 'string' ? args.command : ''
        if (!command.trim()) throw new TaskProtocolError({ code: 'TASK_PROTOCOL_INVALID_REQUEST', message: 'command is required', retryable: false })
        const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? Math.min(args.timeoutMs, timeoutCap) : timeoutCap
        return await runPeerExec(command, timeoutMs)
      } },
  ]
}
