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

export interface DoctorCheck { name: string; ok: boolean; detail?: string; fix?: string }

export interface DoctorInputs {
  installed: boolean
  enrolled: boolean
  running: boolean
  /** Connected peers EXCLUDING self, as reported by mesh info. undefined = daemon not reachable. */
  peerCount?: number
  /** Services visible through discovery. undefined = not queried (daemon down). */
  serviceCount?: number
  /** Own services registered with the local node. */
  localServiceCount?: number
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
