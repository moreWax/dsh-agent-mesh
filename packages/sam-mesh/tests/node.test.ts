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
recorded="$*"
data_dir="$HOME/.config/sam-mesh"
bootstrap=""; token_path=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--data-dir" ]; then data_dir="$2"; shift 2
  elif [ "$1" = "--bootstrap-token-path" ]; then bootstrap="1"; token_path="$2"; shift 2
  else shift; fi
done
mkdir -p "$data_dir"
case "$cmd" in
  join)
    echo "$recorded" > "$data_dir/.stub-join-args"
    if [ "$bootstrap" = "1" ]; then
      [ -f "$token_path" ] && [ "$(cat "$token_path")" = "sam-bt-test-token" ] || { echo "bad bootstrap token" >&2; exit 1; }
      echo "Enrolling via HTTP at https://hub.example:8480"
      echo "Join complete"
      exit 0
    fi
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

  it('treats a bare keypair store as unenrolled (the sam-node reset case)', async () => {
    // reset clears the mesh binding but keeps the keypair, so agent.db exists
    // with no control-plane URL inside. Existence alone must not read as enrolled.
    await mkdir(join(dir, 'data'), { recursive: true })
    await writeFile(join(dir, 'data', 'agent.db'), Buffer.alloc(65536))
    const status = await manager.status()
    expect(status.enrolled).toBe(false)
  })

  it('reads an agent.db carrying a control-plane URL as enrolled', async () => {
    await mkdir(join(dir, 'data'), { recursive: true })
    const store = Buffer.concat([Buffer.alloc(1024), Buffer.from('https://hub.example:8480'), Buffer.alloc(1024)])
    await writeFile(join(dir, 'data', 'agent.db'), store)
    const status = await manager.status()
    expect(status.enrolled).toBe(true)
  })

  it('enrolls with a bootstrap token: right args, 0600 file, scrubbed on settle, no device flow', async () => {
    const session = manager.beginEnrollment({ controlPlane: 'https://hub.example:8480', bootstrapToken: 'sam-bt-test-token' })
    await session.done
    const tokenPath = join(dir, 'data', '.enrollment-token')
    // the join saw the token path (never an inline value) and no auth-mode
    const args = await import('node:fs/promises').then(fs => fs.readFile(join(dir, 'data', '.stub-join-args'), 'utf8'))
    expect(args).toContain('--bootstrap-token-path')
    expect(args).not.toContain('sam-bt-test-token')
    expect(args).not.toContain('--auth-mode')
    // session completed as a bootstrap session without awaiting a user
    const info = session.info()
    expect(info).toMatchObject({ mode: 'bootstrap', state: 'complete', verificationUrl: null, userCode: null })
    // token file scrubbed after settle
    await expect(import('node:fs/promises').then(fs => fs.access(tokenPath))).rejects.toThrow()
  })

  it('reports a rejected bootstrap token as a failed session and still scrubs', async () => {
    const session = manager.beginEnrollment({ bootstrapToken: 'sam-bt-WRONG' })
    await session.done
    const info = session.info()
    expect(info.state).toBe('failed')
    expect(info.error).toContain('bad bootstrap token')
    await expect(import('node:fs/promises').then(fs => fs.access(join(dir, 'data', '.enrollment-token')))).rejects.toThrow()
  })

  it('start writes the managed api-token (0600) before daemonizing', async () => {
    const started = await manager.start({ apiToken: 'managed-api-token-123' })
    expect(started.ok).toBe(true)
    const fs = await import('node:fs/promises')
    const tokenPath = join(dir, 'data', 'api-token')
    expect(await fs.readFile(tokenPath, 'utf8')).toBe('managed-api-token-123')
    const mode = (await fs.stat(tokenPath)).mode & 0o777
    expect(mode).toBe(0o600)
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

  it('activeEnrollment surfaces the in-flight session and clears after resolution', async () => {
    await mkdir(join(dir, 'data'), { recursive: true })
    expect(manager.activeEnrollment()).toBeNull()
    const session = manager.beginEnrollment({ controlPlane: 'https://cp.example' })
    while (session.state === 'starting') await new Promise((r) => setTimeout(r, 50))
    expect(manager.activeEnrollment()?.sessionId).toBe(session.sessionId)
    await writeFile(join(dir, 'data', '.stub-approved'), '')
    await session.done
    expect(manager.activeEnrollment()).toBeNull()
  })
})
