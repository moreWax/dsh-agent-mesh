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
})
