import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SamNodeManager, parseDeviceFlow } from '../src/node/index.js'

const DEVICE_FLOW = `OAuth Device Authorization Flow
------------------------------------------------------------
Open this URL in a browser:

  https://auth.example/device?user_code=ABCD-EFGH

Enter code: ABCD-EFGH

Waiting for authorization...
`

/** A stub sam-node: join prints the device flow then waits for a marker file; run --daemonize writes a pidfile. */
function stubScript(): string {
  return `#!/bin/sh
cmd="$1"; shift
data_dir="$HOME/.config/sam-mesh"
while [ $# -gt 0 ]; do
  if [ "$1" = "--data-dir" ]; then data_dir="$2"; shift 2; else shift; fi
done
case "$cmd" in
  join)
    cat <<'EOF'
${DEVICE_FLOW}EOF
    marker="$data_dir/.stub-approved"
    for i in $(seq 1 600); do [ -f "$marker" ] && { echo "Join complete"; exit 0; }; sleep 0.05; done
    echo "failed to get token: context deadline exceeded"
    exit 1
    ;;
  run)
    sleep 600 >/dev/null 2>&1 &
    echo $! > "$data_dir/sam-node.pid"
    exit 0
    ;;
  *) echo "stub: unknown command $cmd" >&2; exit 2 ;;
esac
`
}

describe('parseDeviceFlow', () => {
  it('extracts the verification URL and user code', () => {
    expect(parseDeviceFlow(DEVICE_FLOW)).toEqual({
      verificationUrl: 'https://auth.example/device?user_code=ABCD-EFGH',
      userCode: 'ABCD-EFGH',
    })
  })
  it('returns null for non-device-flow output', () => {
    expect(parseDeviceFlow('Discovering control plane info...')).toBeNull()
  })
})

describe('SamNodeManager', () => {
  let dir: string
  let manager: SamNodeManager
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sam-mesh-node-'))
    const bin = join(dir, 'bin')
    await mkdir(bin)
    const stub = join(bin, 'sam-node')
    await writeFile(stub, stubScript())
    await chmod(stub, 0o755)
    manager = new SamNodeManager({ samNode: stub, dataDir: join(dir, 'data') })
  })
  afterEach(async () => {
    const status = await manager.status()
    if (status.pid !== null) { try { process.kill(status.pid, 'SIGKILL') } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true })
  })

  it('reports an uninstalled, unenrolled, stopped node honestly', async () => {
    const missing = new SamNodeManager({ samNode: join(dir, 'nope'), dataDir: join(dir, 'data') })
    const status = await missing.status()
    expect(status).toMatchObject({ installed: false, binaryPath: null, enrolled: false, running: false, pid: null })
  })

  it('start is idempotent and stop terminates the daemon', async () => {
    await mkdir(join(dir, 'data'), { recursive: true })
    const first = await manager.start()
    expect(first.ok).toBe(true)
    const running = await manager.status()
    expect(running.running).toBe(true)
    expect(running.pid).not.toBeNull()
    const again = await manager.start()
    expect(again.ok).toBe(true)
    expect(again.ok && again.message).toContain('already running')
    const stopped = await manager.stop()
    expect(stopped.ok).toBe(true)
  })

  it('start refuses when the binary is missing', async () => {
    const missing = new SamNodeManager({ samNode: join(dir, 'nope'), dataDir: join(dir, 'data') })
    const result = await missing.start()
    expect(result.ok).toBe(false)
  })

  it('enrollment surfaces the device flow and completes on approval', async () => {
    await mkdir(join(dir, 'data'), { recursive: true })
    const session = manager.beginEnrollment({ controlPlane: 'https://cp.example' })
    while (session.state === 'starting') await new Promise((r) => setTimeout(r, 50))
    expect(session.state).toBe('awaiting_user')
    expect(session.userCode).toBe('ABCD-EFGH')
    expect(session.verificationUrl).toBe('https://auth.example/device?user_code=ABCD-EFGH')
    expect(manager.enrollment(session.sessionId)?.state).toBe('awaiting_user')
    await writeFile(join(dir, 'data', '.stub-approved'), '')
    await session.done
    expect(session.state).toBe('complete')
  })

  it('enrollment can be cancelled while awaiting the user', async () => {
    await mkdir(join(dir, 'data'), { recursive: true })
    const session = manager.beginEnrollment({ controlPlane: 'https://cp.example' })
    while (session.state === 'starting') await new Promise((r) => setTimeout(r, 50))
    expect(manager.cancelEnrollment(session.sessionId)).toBe(true)
    await session.done
    expect(session.state).toBe('cancelled')
  })
})
