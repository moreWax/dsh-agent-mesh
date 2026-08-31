import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RuntimeError } from './errors.js'

export interface ManagedProcessSpec { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; stateDir: string; logDir: string }
export type SpawnProcess = typeof spawn

export class UserProcessManager {
  private child: ChildProcess | undefined
  constructor(private readonly spec: ManagedProcessSpec, private readonly spawnProcess: SpawnProcess = spawn) {}
  private pidPath(): string { return join(this.spec.stateDir, 'k3s.pid') }
  async start(): Promise<number> {
    if (this.child && this.child.exitCode === null) return this.child.pid!
    await mkdir(this.spec.stateDir, { recursive: true, mode: 0o700 }); await mkdir(this.spec.logDir, { recursive: true, mode: 0o700 })
    const out = await open(join(this.spec.logDir, 'k3s.log'), 'a', 0o600)
    const child = this.spawnProcess(this.spec.command, this.spec.args, { cwd: this.spec.cwd, env: this.spec.env, detached: false, stdio: ['ignore', out.fd, out.fd], shell: false })
    this.child = child
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }).catch(cause => { throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', 'Could not start rootless k3s', 'Inspect the private runtime log and retry', true, { cause }) })
    await writeFile(this.pidPath(), `${child.pid}
`, { mode: 0o600 }); child.once('exit', () => void rm(this.pidPath(), { force: true })); await out.close(); return child.pid!
  }
  async running(): Promise<boolean> {
    if (this.child?.pid && this.child.exitCode === null) return true
    try { const pid = Number((await readFile(this.pidPath(), 'utf8')).trim()); if (!Number.isSafeInteger(pid) || pid <= 1) return false; process.kill(pid, 0); const commandLine = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''); return commandLine.split('\0')[0] === this.spec.command } catch { return false }
  }
  async stop(timeoutMs = 15_000): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) { await rm(this.pidPath(), { force: true }); return }
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, timeoutMs))])
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(this.pidPath(), { force: true }); this.child = undefined
  }
}
