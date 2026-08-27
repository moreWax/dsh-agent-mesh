/**
 * SAM node lifecycle manager: detect, start, stop, and enroll a sam-node —
 * the dsh-independent core that lets any machine join the mesh. Used by the
 * `sam-mesh` CLI and by the dsh plugin's Web UI host. All operations are
 * idempotent; enrollment is an explicit, cancellable session, never a side
 * effect. Identity reset (`sam-node reset`) is deliberately NOT exposed here:
 * destructive identity operations stay human-terminal-only.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createConnection } from 'node:net'
import { randomUUID } from 'node:crypto'
import { bboltGet, hasMeshIdentity, readEnrolledHub } from './bbolt.js'
import { resolveBundledBinary } from './bundled.js'

const execFileAsync = promisify(execFile)

export const DEFAULT_DATA_DIR = join(homedir(), '.config', 'sam-mesh')
export const DEFAULT_CONTROL_PLANE = 'https://hub.sam-mesh.dev'

export interface SamNodeManagerOptions {
  /** Binary path; defaults to `sam-node` resolved from PATH. */
  samNode?: string
  /** Node data directory (identity, pidfile, socket). */
  dataDir?: string
  /** Default control plane for enrollment. */
  controlPlane?: string
  /**
   * Publish RFC1918/ULA addresses to the mesh. Upstream default is true
   * (right for LAN/private hubs). Set false for public-hub posture.
   * Undefined = upstream default.
   */
  announcePrivate?: boolean
}

export interface NodeStatus {
  installed: boolean
  binaryPath: string | null
  /** Where the resolved binary came from: env override, the bundled package, or PATH. */
  binarySource: 'env' | 'bundled' | 'path' | null
  enrolled: boolean
  /** The hub the node is enrolled on (live store read); null when unenrolled. */
  enrolledHub: string | null
  running: boolean
  pid: number | null
  socketPath: string
  dataDir: string
}

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

export type EnrollmentState = 'starting' | 'awaiting_user' | 'complete' | 'failed' | 'cancelled'

export interface EnrollmentInfo {
  sessionId: string
  state: EnrollmentState
  controlPlane: string
  /** `device` = interactive OIDC browser flow; `bootstrap` = pre-shared token, no human step. */
  mode: 'device' | 'bootstrap'
  verificationUrl: string | null
  userCode: string | null
  error: string | null
}

/** Parse the OIDC device-flow block sam-node join prints. Pure. */
export function parseDeviceFlow(text: string): { verificationUrl: string; userCode: string } | null {
  const url = /Open this URL in a browser:\s*\n\s*(\S+)/.exec(text)
  const code = /Enter code:\s*(\S+)/.exec(text)
  const verificationUrl = url?.[1]
  const userCode = code?.[1]
  return verificationUrl && userCode ? { verificationUrl, userCode } : null
}

async function pathExecutable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true } catch { return false }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function socketAnswers(path: string, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); socket.destroy(); resolve(false) })
  })
}

/** One join attempt: owns the child process and surfaces the device-flow URL/code. */
export class EnrollmentSession {
  readonly sessionId = randomUUID()
  state: EnrollmentState = 'starting'
  verificationUrl: string | null = null
  userCode: string | null = null
  error: string | null = null
  private buffer = ''
  private readonly child: ReturnType<typeof spawn>
  readonly done: Promise<void>

  constructor(binary: string, args: string[], readonly controlPlane: string, readonly mode: 'device' | 'bootstrap' = 'device', private readonly onSettle: () => Promise<void> | void = () => {}) {
    this.child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const onData = (chunk: Buffer) => {
      this.buffer += chunk.toString()
      const parsed = parseDeviceFlow(this.buffer)
      if (parsed && this.state === 'starting') {
        this.verificationUrl = parsed.verificationUrl
        this.userCode = parsed.userCode
        this.state = 'awaiting_user'
      }
    }
    this.child.stdout?.on('data', onData)
    this.child.stderr?.on('data', onData)
    this.done = new Promise((resolve) => {
      this.child.once('exit', (code) => {
        if (this.state === 'cancelled') { /* keep */ }
        else if (code === 0) this.state = 'complete'
        else {
          this.state = 'failed'
          this.error = this.buffer.trim().split('\n').slice(-3).join(' ').slice(0, 400) || `join exited with code ${code}`
        }
        // Cleanup (credential-file scrub) is part of settling: `done` resolves
        // only after it, so observers never race the residue.
        void Promise.resolve(this.onSettle()).then(() => resolve(), () => resolve())
      })
    })
  }

  cancel(): void {
    if (this.state === 'complete' || this.state === 'failed') return
    this.state = 'cancelled'
    this.child.kill('SIGTERM')
  }

  info(): EnrollmentInfo {
    return {
      sessionId: this.sessionId, state: this.state, controlPlane: this.controlPlane, mode: this.mode,
      verificationUrl: this.verificationUrl, userCode: this.userCode, error: this.error,
    }
  }
}

export class SamNodeManager {
  private readonly binary: string
  private readonly dataDir: string
  private readonly controlPlane: string
  private readonly announcePrivate: boolean | undefined
  private readonly sessions = new Map<string, EnrollmentSession>()

  constructor(options: SamNodeManagerOptions = {}) {
    this.binary = options.samNode ?? 'sam-node'
    this.dataDir = options.dataDir ?? DEFAULT_DATA_DIR
    this.controlPlane = options.controlPlane ?? DEFAULT_CONTROL_PLANE
    this.announcePrivate = options.announcePrivate
  }

  get socketPath(): string { return join(this.dataDir, 'sam.sock') }
  private get pidPath(): string { return join(this.dataDir, 'sam-node.pid') }
  private get identityPath(): string { return join(this.dataDir, 'agent.db') }

  /**
   * Enrollment detection. `sam-node reset` clears the mesh binding but keeps
   * the keypair (PeerID unchanged), so agent.db EXISTING is not enough — an
   * enrolled node persists its control-plane URL in the store (it must, to
   * renew leases across restarts); a reset node contains no URL marker at
   * all. The scan therefore looks for an `http` marker in the store bytes.
   * Failure direction is benign: if sam-node ever changes its storage format
   * this degrades to "unenrolled" (an unnecessary enrollment prompt, which
   * sam-node itself rejects when the node is in fact enrolled), never to a
   * silent dead mesh.
   */
async status(): Promise<NodeStatus> {
    const binaryPath = await this.resolveBinary()
    let pid: number | null = null
    try {
      const raw = await readFile(this.pidPath, 'utf8')
      const parsed = Number(raw.trim())
      if (Number.isInteger(parsed) && pidAlive(parsed)) pid = parsed
    } catch { /* no pidfile */ }
    let enrolled = false
    let enrolledHub: string | null = null
    try {
      const data = await readFile(this.identityPath)
      enrolled = hasMeshIdentity(data)
      enrolledHub = enrolled ? readEnrolledHub(data) : null
    } catch { /* no store yet */ }
    const running = pid !== null || await socketAnswers(this.socketPath)
    return {
      installed: binaryPath !== null, binaryPath, binarySource: this.binarySource, enrolled, enrolledHub, running, pid,
      socketPath: this.socketPath, dataDir: this.dataDir,
    }
  }

  /** Start the node daemon. Idempotent: a live node is reported, not restarted. */
  /**
   * Start the daemon. When `apiToken` is given, the manager first writes it to
   * `<dataDir>/api-token` (0600) — the credential store is the single source
   * for the local-channel credential, mirrored here so the node enforces it
   * and file-based local clients keep working. Without it, the node's own
   * token behavior is untouched.
   */
  async start(options: { apiToken?: string } = {}): Promise<ActionResult> {
    const before = await this.status()
    if (before.running) return { ok: true, message: `sam-node already running${before.pid ? ` (pid ${before.pid})` : ''}` }
    if (!before.installed) return { ok: false, error: 'sam-node is not installed or not on PATH' }
    try {
      if (options.apiToken !== undefined) {
        const tokenPath = join(this.dataDir, 'api-token')
        await mkdir(this.dataDir, { recursive: true })
        await writeFile(tokenPath, options.apiToken, { mode: 0o600 })
        await chmod(tokenPath, 0o600)
      }
      // Public-hub posture must NOT leak RFC1918/ULA addresses to the swarm
      // (--announce-private defaults to true upstream, correct for LAN hubs).
      const runArgs = ['run', '--daemonize', '--data-dir', this.dataDir]
      if (this.announcePrivate !== undefined) runArgs.push(`--announce-private=${this.announcePrivate}`)
      await execFileAsync(this.binary, runArgs,
        { timeout: 30_000 })
      return { ok: true, message: 'sam-node started' }
    } catch (error) {
      const first = error instanceof Error ? error.message : String(error)
      // Stale-identity self-heal: the hub rotated its signing key (or the
      // biscuit otherwise no longer verifies) — sam-node FATALs at Start()
      // and upstream offers no recovery path. The store usually holds an
      // OIDC refresh token (device flow with --offline-access), so a silent
      // re-enrollment is possible: refresh the JWT, reset the stale identity
      // (PeerID survives), re-join with the JWT. No browser unless the
      // refresh token itself is dead.
      if (await this.detectStaleIdentity(first)) {
        const recovery = await this.recoverStaleIdentity()
        if (recovery.recovered) {
          return { ok: true, message: 'sam-node started (self-healed a stale identity via stored refresh token)' }
        }
        return { ok: false, error: `${first} — automatic re-enrollment failed (${recovery.reason}); re-enroll via the card or 'sam-mesh node join'` }
      }
      return { ok: false, error: first }
    }
  }

  /** Read one string value from the identity bucket; null when absent/unreadable. */
  protected async readStoreValue(key: string): Promise<string | null> {
    try {
      const data = await readFile(join(this.dataDir, 'agent.db'))
      return bboltGet(data, 'identity', key)?.toString('utf8') ?? null
    } catch {
      return null
    }
  }

  /** True when the last start failure looks like a stale-identity FATAL. */
  private async detectStaleIdentity(firstError: string): Promise<boolean> {
    if (/fails role requirement|invalid signature/i.test(firstError)) return true
    try {
      const log = await readFile(join(this.dataDir, 'sam-node.log'), 'utf8')
      return /fails role requirement|invalid signature/i.test(log.slice(-8192))
    } catch {
      return false
    }
  }

  /**
   * Silent re-enrollment using the store's OIDC refresh token — the recovery
   * sam-node itself never attempts when a stored identity stops verifying
   * (hub key rotation). Returns recovered=false with a human reason when the
   * machine cannot heal itself (no refresh token, token rejected, …); the
   * caller then falls back to the device flow. Never throws.
   */
  async recoverStaleIdentity(): Promise<{ recovered: boolean; reason?: string }> {
    try {
      const refreshToken = await this.readStoreValue('refresh_token')
      const issuer = await this.readStoreValue('oidc_issuer')
      const clientId = await this.readStoreValue('oidc_client_id')
      const controlPlane = (await this.readStoreValue('control_plane_url')) ?? this.controlPlane
      if (!refreshToken || !issuer || !clientId) {
        return { recovered: false, reason: 'no stored refresh token (was the node enrolled with offline access?)' }
      }
      const disco = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })
      if (!disco.ok) return { recovered: false, reason: `OIDC discovery failed (${disco.status})` }
      const tokenEndpoint = (await disco.json() as { token_endpoint?: string }).token_endpoint
      if (!tokenEndpoint) return { recovered: false, reason: 'OIDC discovery document has no token_endpoint' }
      const grant = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
        signal: AbortSignal.timeout(15_000),
      })
      const tokenBody = await grant.json().catch(() => ({})) as { access_token?: string; error?: string }
      if (!grant.ok || !tokenBody.access_token) {
        return { recovered: false, reason: `refresh token rejected (${tokenBody.error ?? `http ${grant.status}`}) — re-enroll in the browser` }
      }
      // Clear the stale identity (keeps the PeerID), then enroll with the JWT.
      const jwtPath = join(this.dataDir, '.renewal.jwt')
      await writeFile(jwtPath, tokenBody.access_token, { mode: 0o600 })
      try {
        await execFileAsync(this.binary, ['reset', '--data-dir', this.dataDir], { timeout: 15_000 })
        const args = ['run', '--daemonize', '--data-dir', this.dataDir, '--join', '--control-plane', controlPlane, '--jwt-path', jwtPath]
        if (this.announcePrivate !== undefined) args.push(`--announce-private=${this.announcePrivate}`)
        await execFileAsync(this.binary, args, { timeout: 30_000 })
      } finally {
        await rm(jwtPath, { force: true })
      }
      return { recovered: true }
    } catch (error) {
      return { recovered: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Stop the node via its pidfile. Idempotent. */
  async stop(): Promise<ActionResult> {
    const before = await this.status()
    if (before.pid === null) return { ok: true, message: 'sam-node is not running (no live pidfile)' }
    try {
      process.kill(before.pid, 'SIGTERM')
      return { ok: true, message: `sent SIGTERM to pid ${before.pid}` }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Begin OIDC device-flow enrollment. Returns immediately with the session;
   * the verification URL and user code appear as the child prints them
   * (poll enrollment()). The session completes when the user authorizes in
   * the browser, or fails/cancels. Requires an unenrolled node — joining an
   * enrolled node is rejected by sam-node itself.
   */
  beginEnrollment(options: { controlPlane?: string; offlineAccess?: boolean; bootstrapToken?: string } = {}): EnrollmentSession {
    const controlPlane = options.controlPlane ?? this.controlPlane
    let args: string[]
    let mode: 'device' | 'bootstrap'
    let tokenPath: string | null = null
    if (options.bootstrapToken !== undefined) {
      // Pre-shared-token enrollment: no OIDC, no browser. The token value
      // transits only this process -> a 0600 file the manager owns ->
      // --bootstrap-token-path (never the inline flag: argv is visible in ps).
      // The file is scrubbed when the session settles, however it settles.
      mode = 'bootstrap'
      tokenPath = join(this.dataDir, '.enrollment-token')
      args = ['join', controlPlane, '--bootstrap-token-path', tokenPath, '--data-dir', this.dataDir]
    } else {
      mode = 'device'
      args = ['join', controlPlane, '--auth-mode', 'device', '--data-dir', this.dataDir]
      if (options.offlineAccess !== false) args.push('--offline-access')
    }
    if (tokenPath !== null) this.writeTokenFile(tokenPath, options.bootstrapToken!)
    const scrub = tokenPath !== null ? () => rm(tokenPath, { force: true }).catch(() => {}) : undefined
    const session = new EnrollmentSession(this.binary, args, controlPlane, mode, scrub)
    this.sessions.set(session.sessionId, session)
    void session.done.finally(() => {
      // Completed sessions stay queryable for one sweep interval, then drop.
      setTimeout(() => this.sessions.delete(session.sessionId), 300_000).unref()
    })
    return session
  }

  /** Write a credential file the manager owns: parent dir + 0600, value never logged. */
  private writeTokenFile(path: string, value: string): void {
    void mkdir(this.dataDir, { recursive: true })
      .then(() => writeFile(path, value, { mode: 0o600 }))
      .then(() => chmod(path, 0o600))
      .catch(() => { /* the join child fails on the missing file and the session reports it */ })
  }

  enrollment(sessionId: string): EnrollmentInfo | null {
    return this.sessions.get(sessionId)?.info() ?? null
  }

  /** The most recent in-flight enrollment, if any — what a UI should surface on load. */
  activeEnrollment(): EnrollmentInfo | null {
    let latest: EnrollmentSession | null = null
    for (const session of this.sessions.values()) {
      if (session.state === 'starting' || session.state === 'awaiting_user') latest = session
    }
    return latest?.info() ?? null
  }

  cancelEnrollment(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    session.cancel()
    return true
  }

  private binarySource: 'env' | 'bundled' | 'path' | null = null

  /**
   * Every usable sam-node on this machine, with the one we'd pick marked.
   * Suggestion order: bundled (version-pinned to the kit, integrity-checked)
   * > explicit env/option > PATH. Powers the card's dropdown and
   * `sam-mesh node binary`.
   */
  async binaryOptions(): Promise<Array<{ path: string; source: 'env' | 'bundled' | 'path'; suggested: boolean; tag?: string }>> {
    const options: Array<{ path: string; source: 'env' | 'bundled' | 'path'; suggested: boolean; tag?: string }> = []
    if (this.binary.includes('/') && await pathExecutable(this.binary)) {
      options.push({ path: this.binary, source: 'env', suggested: false })
    }
    try {
      const bundled = await resolveBundledBinary(this.dataDir)
      if (bundled) options.push({ path: bundled.path, source: 'bundled', suggested: true, tag: bundled.tag })
    } catch { /* no bundle for this platform */ }
    const seen = new Set(options.map(o => o.path))
    const candidates = [...(process.env.PATH ?? '').split(':'), join(homedir(), '.local', 'bin'), '/usr/local/bin', '/usr/bin']
    for (const dir of candidates) {
      if (!dir) continue
      const candidate = join(dir, 'sam-node')
      if (!seen.has(candidate) && await pathExecutable(candidate)) {
        seen.add(candidate)
        options.push({ path: candidate, source: 'path', suggested: options.length === 0 })
      }
    }
    // No bundle? The first non-env hit becomes the suggestion (env entries
    // are the user's explicit override, never our suggestion).
    if (options.length > 0 && !options.some(o => o.suggested)) {
      const idx = options.findIndex(o => o.source !== 'env')
      if (idx >= 0) options[idx]!.suggested = true
    }
    return options
  }

  private async resolveBinary(): Promise<string | null> {
    this.binarySource = null
    if (this.binary.includes('/')) {
      const ok = (await pathExecutable(this.binary)) ? this.binary : null
      if (ok) this.binarySource = 'env'
      return ok
    }
    // The npm package CARRIES sam-node: bundled (lazy-extracted, integrity-
    // verified) wins over PATH so a fresh `dsh plugin add` just works.
    try {
      const bundled = await resolveBundledBinary(this.dataDir)
      if (bundled) { this.binarySource = 'bundled'; return bundled.path }
    } catch { /* corrupt bundle falls through to PATH */ }
    // PATH fallback, then the documented user-local install location — service
    // managers (systemd user units) routinely run with a stripped PATH that
    // omits ~/.local/bin, and a stripped PATH must not read as "not installed".
    const candidates = [
      ...(process.env.PATH ?? '').split(':'),
      join(homedir(), '.local', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
    ]
    for (const dir of candidates) {
      if (!dir) continue
      const candidate = join(dir, this.binary)
      if (await pathExecutable(candidate)) { this.binarySource = 'path'; return candidate }
    }
    return null
  }
}
