import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SamNodeManager } from '../src/node/index.js'

/**
 * Stale-identity self-heal: when the hub rotates its signing key, sam-node
 * FATALs "loaded identity fails role requirement … invalid signature" and
 * upstream offers no recovery. The manager must heal itself from the store's
 * OIDC refresh token (reset → re-join with a refreshed JWT), surfacing a
 * human reason only when the machine cannot.
 */

const STALE = 'loaded identity fails role requirement "sam:role:node": biscuit: invalid signature'

/** run --daemonize fails stale unless --jwt-path is present AND reset ran first; reset records order. */
function stubScript(): string {
  return `#!/bin/sh
cmd="$1"; shift
data_dir="$HOME/.config/sam-mesh"
jwt=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--data-dir" ]; then data_dir="$2"; shift 2
  elif [ "$1" = "--jwt-path" ]; then jwt="$2"; shift 2
  else shift; fi
done
mkdir -p "$data_dir"
echo "$cmd" >> "$data_dir/.stub-order"
case "$cmd" in
  reset)
    touch "$data_dir/.stub-reset"
    exit 0
    ;;
  run)
    if [ -n "$jwt" ]; then
      [ -f "$data_dir/.stub-reset" ] || { echo "join without reset" >&2; exit 1; }
      [ -f "$jwt" ] || { echo "jwt file missing" >&2; exit 1; }
      [ "$(cat "$jwt")" = "fresh-jwt-from-refresh" ] || { echo "wrong jwt" >&2; exit 1; }
      echo $$ > "$data_dir/sam-node.pid"
      exit 0
    fi
    echo '${STALE}' >&2
    echo '${STALE}' >> "$data_dir/sam-node.log"
    exit 1
    ;;
esac
exit 0
`
}

class TestManager extends SamNodeManager {
  constructor(private readonly store: Record<string, string | null>, opts: { samNode: string; dataDir: string }) {
    super(opts)
  }
  protected override async readStoreValue(key: string): Promise<string | null> {
    return this.store[key] ?? null
  }
}

describe('stale-identity self-heal', () => {
  let dir: string
  let stub: string
  let oidc: Server
  let oidcUrl: string
  let grantBehavior: 'ok' | 'reject'
  let grantBody: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sam-recover-'))
    stub = join(dir, 'sam-node-stub')
    await writeFile(stub, stubScript(), { mode: 0o755 })
    await chmod(stub, 0o755)
    grantBehavior = 'ok'
    grantBody = ''
    oidc = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ token_endpoint: `${oidcUrl}/token` }))
        return
      }
      if (req.url === '/token' && req.method === 'POST') {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          grantBody = body
          if (grantBehavior === 'reject') {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'invalid_grant' }))
            return
          }
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ access_token: 'fresh-jwt-from-refresh', token_type: 'Bearer', expires_in: 3600 }))
        })
        return
      }
      res.statusCode = 404
      res.end()
    })
    await new Promise<void>((resolve) => oidc.listen(0, '127.0.0.1', resolve))
    oidcUrl = `http://127.0.0.1:${(oidc.address() as { port: number }).port}`
  })

  afterEach(async () => {
    await new Promise((resolve) => oidc.close(resolve))
    await rm(dir, { recursive: true, force: true })
  })

  function manager(store: Record<string, string | null> = {}): TestManager {
    return new TestManager({
      refresh_token: 'stored-refresh-token',
      oidc_issuer: oidcUrl,
      oidc_client_id: 'sam-mesh-audience',
      control_plane_url: 'https://hub.example',
      ...store,
    }, { samNode: stub, dataDir: join(dir, 'data') })
  }

  it('start() self-heals a stale identity: refresh → reset → re-join with JWT → running', async () => {
    const result = await manager().start()
    if (!result.ok) throw new Error(`expected ok: ${result.error}`)
    expect(result.message).toContain('self-healed')
    const order = (await readFile(join(dir, 'data/.stub-order'), 'utf8')).trim().split('\n')
    expect(order).toEqual(['run', 'reset', 'run'])  // failed start, then reset, then the jwt re-join
    await expect(readFile(join(dir, 'data/.renewal.jwt'), 'utf8')).rejects.toThrow()  // JWT file cleaned up
    const params = new URLSearchParams(grantBody)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('stored-refresh-token')
    expect(params.get('client_id')).toBe('sam-mesh-audience')
  })

  it('refresh-token rejection falls back to a human reason, never throws', async () => {
    grantBehavior = 'reject'
    const result = await manager().start()
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('automatic re-enrollment failed')
    expect(result.error).toContain('refresh token rejected')
    expect(result.error).toContain('invalid_grant')
  })

  it('no stored refresh token → clear device-flow guidance', async () => {
    const result = await manager({ refresh_token: null, oidc_issuer: null, oidc_client_id: null }).start()
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('no stored refresh token')
    expect(result.error).toContain('sam-mesh node join')
  })

  it('does not attempt recovery for unrelated start failures', async () => {
    // stub whose plain run fails with something that is NOT a stale identity
    const other = join(dir, 'sam-node-other')
    await writeFile(other, `#!/bin/sh
data_dir="$HOME/.config/sam-mesh"
while [ $# -gt 0 ]; do
  if [ "$1" = "--data-dir" ]; then data_dir="$2"; shift 2
  else shift; fi
done
mkdir -p "$data_dir"
echo "bind: address already in use" >&2
echo "bind: address already in use" >> "$data_dir/sam-node.log"
exit 1
`, { mode: 0o755 })
    const m = new TestManager({
      refresh_token: 'stored-refresh-token',
      oidc_issuer: oidcUrl,
      oidc_client_id: 'sam-mesh-audience',
    }, { samNode: other, dataDir: join(dir, 'data-other') })
    const result = await m.start()
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('address already in use')
    expect(result.error).not.toContain('automatic re-enrollment')
    expect(grantBody).toBe('')  // never touched the OIDC server
  })

  it('routine AuthZ invalid-signature noise in the log never triggers recovery', async () => {
    // exactly the Mac false-positive: hub unreachable, but the log tail is
    // full of '[Auth] AuthZ Denied <peer>: biscuit: invalid signature' from
    // other peers' traffic — recovery must not fire (it would reset a
    // healthy identity)
    const noisy = join(dir, 'sam-node-noisy')
    await writeFile(noisy, `#!/bin/sh
data_dir="$HOME/.config/sam-mesh"
while [ $# -gt 0 ]; do
  if [ "$1" = "--data-dir" ]; then data_dir="$2"; shift 2
  else shift; fi
done
mkdir -p "$data_dir"
echo "[Auth] AuthZ Denied 12D3KooW: biscuit: invalid signature" >> "$data_dir/sam-node.log"
echo "failed to authenticate with any router: all connection attempts failed" >&2
echo "FATAL Failed to start mesh node: failed to authenticate with any router" >> "$data_dir/sam-node.log"
exit 1
`, { mode: 0o755 })
    const m = new TestManager({
      refresh_token: 'stored-refresh-token',
      oidc_issuer: oidcUrl,
      oidc_client_id: 'sam-mesh-audience',
    }, { samNode: noisy, dataDir: join(dir, 'data-noisy') })
    const result = await m.start()
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('failed to authenticate')
    expect(result.error).not.toContain('automatic re-enrollment')
    expect(grantBody).toBe('')
  })
})


describe('router-handshake rejection (runtime key rotation)', () => {
  it('detects stale identity from the router FATAL + stream-reset signature, but not from plain hub-down timeouts', async () => {
    const { SamNodeManager } = await import('../src/node/manager.js')
    const dir = await mkdtemp(join(tmpdir(), 'router-reject-'))
    const manager = new SamNodeManager({ dataDir: dir } as never)
    const detect = (manager as unknown as { detectStaleIdentity(firstError: string): Promise<boolean> }).detectStaleIdentity.bind(manager)

    // hub-down: dial timeouts, no reset signature → never touch the identity
    await writeFile(join(dir, 'sam-node.log'), 'failed to dial: context deadline exceeded\nfailed to dial: context deadline exceeded\n')
    expect(await detect('Failed to start mesh node: failed to authenticate with any router: all connection attempts failed')).toBe(false)

    // runtime rotation: router FATAL + handshake auth rejection in the tail → heal
    await writeFile(join(dir, 'sam-node.log'), '[AuthN] handshake failed with router /ip4/1.2.3.4/tcp/4501/p2p/x: read auth response: stream reset (remote): code: 0x0: transport error: stream 4 canceled by remote with error code 0\n')
    expect(await detect('Failed to start mesh node: failed to authenticate with any router: all connection attempts failed')).toBe(true)

    // reset signature alone without the router FATAL → conservative no
    expect(await detect('Failed to start mesh node: some unrelated fatal')).toBe(false)
  })
})


describe('runtime trust watcher', () => {
  it('runs the heal ladder when the log tail says our identity is stale; stays quiet when healthy', async () => {
    const { SamNodeManager } = await import('../src/node/manager.js')
    const dir = await mkdtemp(join(tmpdir(), 'trust-watch-'))
    const manager = new SamNodeManager({ dataDir: dir } as never)
    const calls: string[] = []
    // stub status() → running, recoverStaleIdentity → records
    ;(manager as unknown as { status: () => Promise<{ running: boolean }> }).status = async () => ({ running: true })
    ;(manager as unknown as { recoverStaleIdentity: () => Promise<{ recovered: boolean }> }).recoverStaleIdentity = async () => { calls.push('recover'); return { recovered: true } }
    ;(manager as unknown as { startTrustWatcher(): void }).startTrustWatcher = () => { calls.push('watch-restart') }
    ;(manager as unknown as { stopTrustWatcher(): void }).stopTrustWatcher = () => { calls.push('watch-stop') }

    const tick = (manager as unknown as { trustWatchTick(): Promise<void> }).trustWatchTick.bind(manager)

    // healthy tail: nothing happens
    await writeFile(join(dir, 'sam-node.log'), '[Discovery] FindProvidersByType returned 7 peers\n')
    await tick()
    expect(calls).toEqual([])

    // stale tail: 3 distinct peers reject us → stop watcher, recover, restart watcher
    const reject = (p: string) => `[Discovery] catalog fetch from ${p} failed: auth rejected by ${p}: authorization failed`
    await writeFile(join(dir, 'sam-node.log'), [reject('12D3KooWAAAA1111x'), reject('12D3KooWBBBB2222x'), reject('12D3KooWCCCC3333x')].join('\n'))
    await tick()
    expect(calls).toEqual(['watch-stop', 'recover', 'watch-restart'])

    // cooldown: a second stale tick inside 15 minutes is skipped (no churn against a mid-rotation hub)
    ;(manager as unknown as { recoverStaleIdentity: () => Promise<{ recovered: boolean; reason?: string }> }).recoverStaleIdentity = async () => { calls.push('recover2'); return { recovered: false, reason: 'refresh token rejected (invalid_request)' } }
    await tick()
    expect(calls).not.toContain('recover2')
    // ...but once the cooldown marker is old, the escalation marker file lands
    await writeFile(join(dir, '.trust-heal-cooldown'), '0')
    await tick()
    expect(calls).toContain('recover2')
    const marker = await readFile(join(dir, 'needs-reenroll.txt'), 'utf8')
    expect(marker).toContain('refresh token rejected')
  })
})


describe('enrollment auto-retry on transient failures (A3)', () => {
  it('respawns the child in-place on a transient post-enroll failure — same sessionId, fresh code, then completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enroll-retry-'))
    const stub = join(dir, 'stub-node.sh')
    await writeFile(stub, `#!/bin/sh
MARKER="${dir}/.attempt"
N=$(cat "$MARKER" 2>/dev/null || echo 0)
N=$((N+1)); echo $N > "$MARKER"
if [ "$N" -lt 2 ]; then
  echo "Open this URL in a browser: https://auth.sam-mesh.dev/device?user_code=AAAA-BBBB"
  echo "Enter code: AAAA-BBBB"
  echo "2026-01-01 FATAL Enrollment failed: failed to connect and authenticate with any router after HTTP enrollment (last error: fatal authentication error: failed to verify router biscuit: no valid key found for verification: biscuit: invalid signature)"
  exit 1
fi
echo "Open this URL in a browser: https://auth.sam-mesh.dev/device?user_code=CCCC-DDDD"
echo "Enter code: CCCC-DDDD"
echo "Enrolled."
exit 0
`, { mode: 0o755 })
    await chmod(stub, 0o755)
    const { EnrollmentSession } = await import('../src/node/manager.js')
    const session = new EnrollmentSession(stub, [], 'https://hub.sam-mesh.dev')
    await session.done
    expect(session.state).toBe('complete')
    expect(session.attempts).toBe(2)
  })

  it('expired device codes also respawn (up to the attempt cap), then fail with the real error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enroll-expire-'))
    const stub = join(dir, 'stub-node.sh')
    await writeFile(stub, `#!/bin/sh
echo "Open this URL in a browser: https://auth.sam-mesh.dev/device?user_code=XXXX-YYYY"
echo "Enter code: XXXX-YYYY"
echo "FATAL Failed to join: failed to get token: device authorization expired before completion"
exit 1
`, { mode: 0o755 })
    await chmod(stub, 0o755)
    const { EnrollmentSession } = await import('../src/node/manager.js')
    const session = new EnrollmentSession(stub, [], 'https://hub.sam-mesh.dev')
    await session.done
    expect(session.state).toBe('failed')
    expect(session.attempts).toBe(3) // MAX_ATTEMPTS, then the honest error
    expect(session.error).toContain('expired')
  })

  it('a non-transient failure does NOT respawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enroll-hard-'))
    const stub = join(dir, 'stub-node.sh')
    await writeFile(stub, `#!/bin/sh
echo "FATAL something genuinely broken"
exit 1
`, { mode: 0o755 })
    await chmod(stub, 0o755)
    const { EnrollmentSession } = await import('../src/node/manager.js')
    const session = new EnrollmentSession(stub, [], 'https://hub.sam-mesh.dev')
    await session.done
    expect(session.state).toBe('failed')
    expect(session.attempts).toBe(1)
  })
})
