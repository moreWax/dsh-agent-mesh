import { mkdir, open, rm, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { runCommand, type CommandRunner } from './command.js'
import { RuntimeError } from './errors.js'

export interface SystemdUserSpec { unitName: string; unitPath: string; executable: string; args: string[]; environment: Record<string, string>; workingDirectory: string }
function escape(value: string): string { return value.replace(/\\/g, '\\x5c').replace(/"/g, '\\x22').replace(/%/g, '%%').replace(/\n|\r/g, '') }
function argument(value: string): string { return `"${escape(value)}"` }

export function renderSystemdUserUnit(spec: SystemdUserSpec): string {
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(spec.unitName)) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Invalid user service name', undefined, false)
  if (Object.keys(spec.environment).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Invalid user service environment key', undefined, false)
  const environment = Object.entries(spec.environment).map(([key, value]) => `Environment=${argument(`${key}=${value}`)}`).join('\n')
  return `[Unit]\nDescription=dsh-imessage private rootless k3s\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nDelegate=yes\nKillMode=mixed\nRestart=on-failure\nRestartSec=2\nWorkingDirectory=${escape(spec.workingDirectory)}\n${environment}\nExecStart=${[spec.executable, ...spec.args].map(argument).join(' ')}\n\n[Install]\nWantedBy=default.target\n`
}

export class SystemdUserManager {
  constructor(private readonly spec: SystemdUserSpec, private readonly runner: CommandRunner = runCommand) {}
  private async systemctl(args: string[], signal?: AbortSignal): Promise<string> { try { return (await this.runner({ command: 'systemctl', args: ['--user', ...args], timeoutMs: 20_000, ...(signal ? { signal } : {}) })).stdout } catch (cause) { throw new RuntimeError('IMESSAGE_RUNTIME_UNAVAILABLE', 'The user service manager is unavailable', 'Use direct process mode or enable the user systemd session', true, { cause }) } }
  async available(signal?: AbortSignal): Promise<boolean> { try { await this.systemctl(['show-environment'], signal); return true } catch { return false } }
  async install(signal?: AbortSignal): Promise<void> { await mkdir(dirname(this.spec.unitPath), { recursive: true, mode: 0o700 }); const temporary = `${this.spec.unitPath}.${process.pid}.tmp`; const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(renderSystemdUserUnit(this.spec)); await handle.sync() } finally { await handle.close() }; await rename(temporary, this.spec.unitPath); await this.systemctl(['daemon-reload'], signal) }
  async start(signal?: AbortSignal): Promise<void> { await this.install(signal); await this.systemctl(['enable', '--now', this.spec.unitName], signal) }
  async running(signal?: AbortSignal): Promise<boolean> { try { return (await this.systemctl(['is-active', this.spec.unitName], signal)).trim() === 'active' } catch { return false } }
  async stop(signal?: AbortSignal): Promise<void> { await this.systemctl(['disable', '--now', this.spec.unitName], signal).catch(() => undefined) }
  async remove(signal?: AbortSignal): Promise<void> { await this.stop(signal); await rm(this.spec.unitPath, { force: true }); await this.systemctl(['daemon-reload'], signal).catch(() => undefined) }
}
