import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSystemdUserUnit, SystemdUserManager } from '../src/runtime/systemd-user.js'
import type { CommandRequest, CommandRunner } from '../src/runtime/command.js'

const dirs: string[] = []
afterEach(async () => await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))))
function spec(path: string) { return { unitName: 'dsh-imessage-k3s.service', unitPath: path, executable: '/home/user/runtime/k3s', args: ['server', '--rootless', '--data-dir', '/home/user/data with spaces'], environment: { PATH: '/home/user/bin:/usr/bin', TOKEN: 'not-a-real-token' }, workingDirectory: '/home/user/state' } }

describe('user systemd lifecycle', () => {
  it('renders a user-only delegated service with quoted arguments', () => {
    const unit = renderSystemdUserUnit(spec('/tmp/unit'))
    expect(unit).toContain('Delegate=yes'); expect(unit).toContain('KillMode=mixed')
    expect(unit).toContain('ExecStart="/home/user/runtime/k3s" "server" "--rootless"')
    expect(unit).not.toContain('sudo'); expect(unit).not.toContain('/etc/systemd')
  })
  it('atomically installs and manages only the declared user unit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'im-systemd-')); dirs.push(root); const calls: CommandRequest[] = []
    const runner: CommandRunner = async request => { calls.push(request); return { stdout: request.args.includes('is-active') ? 'active\n' : '', stderr: '' } }
    const path = join(root, 'dsh-imessage-k3s.service'); const manager = new SystemdUserManager(spec(path), runner)
    await manager.start(); expect(await readFile(path, 'utf8')).toContain('Delegate=yes'); expect(await manager.running()).toBe(true); await manager.stop(); await manager.start(); expect(await manager.running()).toBe(true); await manager.remove()
    expect(calls.every(call => call.command === 'systemctl' && call.args[0] === '--user')).toBe(true)
    expect(calls.some(call => call.args.includes('enable') && call.args.includes('--now'))).toBe(true)
    expect(calls.some(call => call.args.includes('disable') && call.args.includes('--now'))).toBe(true)
  })
})
