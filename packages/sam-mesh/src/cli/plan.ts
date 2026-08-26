/**
 * Pure decision + formatting helpers for the self-contained node onboarding
 * flow (join = maybe-install -> enroll -> maybe-start) and for hub operators
 * minting bootstrap tokens. No I/O here: the CLI owns prompts and processes,
 * these own the decisions and the paste-ready output.
 */

export interface JoinPrerequisites { installed: boolean; enrolled: boolean }

export type JoinStep =
  | { action: 'install-offer' }
  | { action: 'already-enrolled'; dataDir?: string }
  | { action: 'join' }

/**
 * The gate order for `node join`. Interactive terminals get an install offer;
 * non-interactive contexts (CI, scripts) get an instruction instead of a
 * surprise network fetch — same decision, different presentation upstream.
 */
export function nextJoinStep(status: JoinPrerequisites, interactive: boolean): JoinStep {
  if (!status.installed) return { action: 'install-offer' }
  if (status.enrolled) return { action: 'already-enrolled' }
  void interactive
  return { action: 'join' }
}

/** What the CLI tells a non-interactive caller when sam-node is missing. */
export const INSTALL_INSTRUCTION =
  'sam-node is not installed. Run: npx @morewax/sam-mesh node install'

/** The official installer this kit delegates to — we do not redistribute binaries. */
export const SAM_INSTALL_CMD = 'curl -sL https://sam-mesh.dev/install.sh | bash'

/**
 * The operator-facing paste block for a freshly minted bootstrap token: store
 * the secret as a 0600 file, then run one command against the same hub.
 */
export function formatMintBlock(token: string, controlPlane: string): string {
  return [
    '# on the joining machine:',
    `printf '%s' '${token}' > ~/sam-join-token && chmod 600 ~/sam-join-token`,
    '',
    `npx @morewax/sam-mesh node join --control-plane ${controlPlane} \\`,
    '  --bootstrap-token-path ~/sam-join-token',
    '',
  ].join('\n')
}

// ─── doctor ────────────────────────────────────────────────────────────────

export interface DoctorCheck { name: string; ok: boolean; detail?: string | undefined; fix?: string | undefined }

export interface DoctorInputs {
  installed: boolean
  enrolled: boolean
  running: boolean
  /** Connected peers EXCLUDING self, as reported by mesh info. undefined = daemon not reachable. */
  peerCount?: number | undefined
  /** Services visible through discovery. undefined = not queried (daemon down). */
  serviceCount?: number | undefined
  /** Own services registered with the local node. */
  localServiceCount?: number | undefined
}

/** Each failed check carries the exact next command — doctor is advice, not just status. */
export function buildChecks(input: DoctorInputs): DoctorCheck[] {
  const checks: DoctorCheck[] = [
    { name: 'sam-node binary', ok: input.installed, fix: input.installed ? undefined : 'npx @morewax/sam-mesh node install' },
    { name: 'enrolled on a hub', ok: input.enrolled,
      fix: input.enrolled ? undefined : 'npx @morewax/sam-mesh node join --control-plane <hub-url> --bootstrap-token-path ~/sam-join-token' },
    { name: 'node daemon', ok: input.running, fix: input.running ? undefined : 'npx @morewax/sam-mesh node start' },
  ]
  if (!input.installed || !input.enrolled || !input.running) return checks
  checks.push({
    name: 'mesh connectivity',
    ok: (input.peerCount ?? 0) > 0,
    detail: input.peerCount === undefined ? 'daemon did not answer' : `${input.peerCount} peer(s) connected`,
    fix: (input.peerCount ?? 0) > 0 ? undefined : 'check the router is up and reachable (hub operator)',
  })
  checks.push({
    name: 'your services announced',
    ok: (input.localServiceCount ?? 0) > 0,
    detail: `${input.localServiceCount ?? 0} registered locally`,
    fix: (input.localServiceCount ?? 0) > 0 ? undefined : 'nothing wrong — machines can consume the mesh without announcing',
  })
  checks.push({
    name: 'remote services visible',
    ok: (input.serviceCount ?? 0) > 0,
    detail: `${input.serviceCount ?? 0} discoverable`,
    fix: (input.serviceCount ?? 0) > 0 ? undefined : 'nothing to call yet — other peers announce nothing (or you are alone)',
  })
  return checks
}

/** Human rendering: ✓/✗ per line, fix command indented under every failure. Pure. */
export function renderDoctor(checks: DoctorCheck[]): string {
  const lines: string[] = []
  let failures = 0
  for (const c of checks) {
    const mark = c.ok ? '\u2713' : '\u2717'
    lines.push(`${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    if (!c.ok) {
      failures += 1
      if (c.fix) lines.push(`   fix: ${c.fix}`)
    }
  }
  lines.push(failures === 0 ? 'all good — you are on the mesh.' : `${failures} issue(s) found.`)
  return lines.join('\n')
}

// ─── peers ─────────────────────────────────────────────────────────────────

/** Short display form of a peer id: stable prefix, enough to disambiguate casually. */
export function shortId(peerId: string): string { return peerId.slice(0, 12) + '\u2026' }

export type PeerMatch =
  | { ok: true; peer: string }
  | { ok: false; candidates: string[] }

/**
 * Resolve what a human typed against the known peer list: exact match wins;
 * otherwise a unique prefix expands; ambiguous prefixes list their candidates.
 */
export function expandPeer(input: string, knownPeers: string[]): PeerMatch {
  if (knownPeers.includes(input)) return { ok: true, peer: input }
  const matches = knownPeers.filter(p => p.startsWith(input))
  if (matches.length === 1) return { ok: true, peer: matches[0]! }
  return { ok: false, candidates: matches.length > 1 ? matches : [...knownPeers].sort() }
}

// ─── token handoff ─────────────────────────────────────────────────────────

/**
 * One-liner an operator pastes on THIS machine to place the token on the
 * joining machine over SSH. The token is alphanumeric+dash, so plain
 * single-quoting is safe. Printed, never executed — remote writes need an
 * explicit human paste.
 */
export function formatSshHandoff(token: string, sshTarget: string): string {
  return `ssh ${sshTarget} "printf '%s' '${token}' > ~/sam-join-token && chmod 600 ~/sam-join-token"`
}

/** QR output uses the system `qrencode` when present; we do not vendor a QR engine. */
export const QR_MISSING_HINT =
  'install qrencode for terminal QR output (brew install qrencode / apt install qrencode) — or use the paste block above'

// ─── task tail ─────────────────────────────────────────────────────────────

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired'])

/** Extract the pieces the tail loop needs from a task_watch payload. Pure. */
export function parseWatch(payload: unknown): {
  status?: string | undefined; cursor?: string | undefined; terminal: boolean; events: unknown[]
} {
  const value = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const task = (value.task && typeof value.task === 'object' ? value.task : {}) as Record<string, unknown>
  const status = typeof task.status === 'string' ? task.status : undefined
  const events = Array.isArray(value.events) ? value.events : []
  return {
    status,
    cursor: typeof value.cursor === 'string' ? value.cursor : undefined,
    terminal: status !== undefined && TERMINAL.has(status),
    events,
  }
}

// ─── service capability ────────────────────────────────────────────────────

/**
 * Inject a fleet capability into tool arguments. Gated services (e.g. our
 * task-service on the public hub) reject calls without it; ungated services
 * ignore the extra field. The capability travels inside arguments because
 * sam-node's pass-through owns every other MCP message end-to-end.
 */
export function withCapability(args: Record<string, unknown>, capability: string | undefined): Record<string, unknown> {
  if (!capability) return args
  return { ...args, _capability: capability }
}

// ─── fleet onboarding ──────────────────────────────────────────────────────

/**
 * A fleet invite: everything a new machine needs to become a full peer,
 * carried as one 0600 file. Created by `fleet invite` on any fleet machine,
 * consumed by `fleet join --invite <file>` on the joining one. The capability
 * is a secret — the file is 0600 and travels by ssh/QR, never chat.
 */
export interface FleetInvite {
  version: 1
  controlPlane: string
  /** Fleet-unique service name both sides announce (public-hub discovery key). */
  serviceName: string
  /** Fleet capability: mesh calls to gated fleet services must present it. */
  capability: string
  /** False on the public hub (never leak RFC1918); true on private/LAN hubs. */
  announcePrivate: boolean
  /** Private-hub only: unattended enrollment. Public-hub joins use the device flow. */
  bootstrapToken?: string | undefined
  createdAt: string
}

export function encodeFleetInvite(invite: FleetInvite): string {
  return JSON.stringify(invite, null, 2) + '\n'
}

export function decodeFleetInvite(text: string): FleetInvite | { error: string } {
  let value: unknown
  try { value = JSON.parse(text) } catch { return { error: 'invite is not valid JSON' } }
  const v = value as Record<string, unknown>
  if (v?.version !== 1) return { error: 'unsupported invite version (expected 1)' }
  if (typeof v.controlPlane !== 'string' || !v.controlPlane.startsWith('http')) return { error: 'invite has no valid controlPlane' }
  if (typeof v.serviceName !== 'string' || !v.serviceName) return { error: 'invite has no serviceName' }
  if (typeof v.capability !== 'string' || v.capability.length < 16) return { error: 'invite has no usable capability' }
  return {
    version: 1, controlPlane: v.controlPlane, serviceName: v.serviceName,
    capability: v.capability, announcePrivate: v.announcePrivate !== false,
    ...(typeof v.bootstrapToken === 'string' && v.bootstrapToken ? { bootstrapToken: v.bootstrapToken } : {}),
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : new Date().toISOString(),
  }
}

/** Decide what enrollment step a join needs. Pure — tested against every hub-state combination. */
export type FleetJoinEnrollment =
  | { action: 'enroll' }                                  // not enrolled anywhere
  | { action: 'none' }                                    // already on the fleet's hub
  | { action: 'reset-required'; currentHub: string }      // enrolled elsewhere: destructive, needs typed confirm

export function fleetJoinEnrollment(enrolled: boolean, enrolledHub: string | null, invite: FleetInvite): FleetJoinEnrollment {
  if (!enrolled) return { action: 'enroll' }
  const normalize = (u: string) => u.replace(/\/+$/, '')
  if (enrolledHub && normalize(enrolledHub) === normalize(invite.controlPlane)) return { action: 'none' }
  return { action: 'reset-required', currentHub: enrolledHub ?? 'unknown hub' }
}

/**
 * Merge refs into a dsh v1 credentials file WITHOUT clobbering: existing
 * keys win (a machine's own SAM_NODE_AUTH is never overwritten), missing
 * keys are appended under refs:. Returns the new file text. Pure.
 */
export function mergeCredentialRefs(fileText: string | null, refs: Record<string, string>): string {
  const lines = (fileText ?? 'version: 1\nrefs:\n').split('\n')
  const present = new Set(
    lines.map(l => /^ {2}([A-Z0-9_]+):/.exec(l)?.[1]).filter((k): k is string => k !== undefined),
  )
  const additions = Object.entries(refs).filter(([k]) => !present.has(k))
  if (additions.length === 0) return lines.join('\n')
  const block = additions.map(([k, v]) => `  ${k}: ${v}`)
  const refsIndex = lines.findIndex(l => /^refs:/.test(l))
  if (refsIndex === -1) return [...lines.filter(l => l.trim() !== ''), 'refs:', ...block, ''].join('\n')
  return [...lines.slice(0, refsIndex + 1), ...block, ...lines.slice(refsIndex + 1)].join('\n')
}

/** The dsh profile patch rows for fleet posture. RESTATES every key — cordis patch replaces row config. */
export function fleetProfilePatch(invite: FleetInvite): string {
  return `# Fleet posture from sam-mesh fleet invite (${invite.createdAt}).
# NOTE: patch config REPLACES row config (no merge) — every key is restated.
- id: agent-mesh
  config:
    socketPath: ~/.config/sam-mesh/sam.sock
    tcpUrl: http://127.0.0.1:8080
    preferSocket: true
    nodeCredentialRef: SAM_NODE_AUTH
    nodeControlPlane: ${invite.controlPlane}
    nodeAnnouncePrivate: ${invite.announcePrivate}
- id: agent-mesh-task-service
  config:
    host: 127.0.0.1
    port: 0
    path: /mcp
    healthPath: /healthz
    serviceName: ${invite.serviceName}
    registerWithSam: true
    shutdownTimeoutMs: 5000
    dbPath: ~/.dsh/storages/agent-mesh-task-service/tasks.db
    capabilityCredentialRef: MESH_TASK_CAPABILITY
`
}

/**
 * Merge fleet rows into an existing profile patch. Appending rows is safe
 * (YAML array); replacing existing agent-mesh rows textually is NOT — that
 * case hands back to the human with the exact block to reconcile.
 */
export function mergeProfilePatch(existing: string | null, invite: FleetInvite): { text: string } | { conflict: string } {
  const ours = fleetProfilePatch(invite)
  if (existing === null || existing.trim() === '') return { text: ours }
  if (/^- id: agent-mesh/m.test(existing) || /^  - id: agent-mesh/m.test(existing) || /id: agent-mesh/.test(existing)) {
    return { conflict: `profile patch already has agent-mesh rows — reconcile manually with:\n\n${ours}` }
  }
  const trimmed = existing.endsWith('\n') ? existing : existing + '\n'
  return { text: trimmed + ours }
}
