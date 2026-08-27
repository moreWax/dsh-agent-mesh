import { describe, expect, it } from 'vitest'
import { buildChecks, decodeFleetInvite, encodeFleetInvite, expandPeer, fleetJoinEnrollment, formatMintBlock, formatSshHandoff, mergeCredentialRefs, mergeProfilePatch, nextJoinStep, parseWatch, renderDoctor, shortId, withCapability, type FleetInvite } from '../src/cli/plan.js'

describe('nextJoinStep', () => {
  it('offers install when the binary is missing — interactive or not', () => {
    expect(nextJoinStep({ installed: false, enrolled: false }, true)).toEqual({ action: 'install-offer' })
    expect(nextJoinStep({ installed: false, enrolled: false }, false)).toEqual({ action: 'install-offer' })
  })

  it('refuses an already-enrolled machine before anything else', () => {
    expect(nextJoinStep({ installed: true, enrolled: true }, true)).toEqual({ action: 'already-enrolled' })
  })

  it('proceeds when installed and unenrolled', () => {
    expect(nextJoinStep({ installed: true, enrolled: false }, false)).toEqual({ action: 'join' })
  })
})

describe('formatMintBlock', () => {
  const block = formatMintBlock('sam-bt-abc123', 'http://192.168.50.17:8480')

  it('stores the token as a 0600 file, never inline in the join command', () => {
    expect(block).toContain("printf '%s' 'sam-bt-abc123' > ~/sam-join-token && chmod 600 ~/sam-join-token")
    expect(block).toContain('--bootstrap-token-path ~/sam-join-token')
    expect(block).not.toContain('--bootstrap-token sam-bt-abc123')
  })

  it('points the join at the same hub the token was minted on', () => {
    expect(block).toContain('--control-plane http://192.168.50.17:8480')
  })

  it('names the npx entry so no clone is needed once published', () => {
    expect(block).toContain('npx @morewax/sam-mesh node join')
  })
})

describe('doctor', () => {
  it('green path reports all-good', () => {
    const checks = buildChecks({ installed: true, enrolled: true, running: true, peerCount: 2, serviceCount: 1, localServiceCount: 1 })
    expect(checks.every(c => c.ok)).toBe(true)
    expect(renderDoctor(checks)).toContain('all good')
  })
  it('every failure carries a fix command', () => {
    const checks = buildChecks({ installed: false, enrolled: false, running: false })
    expect(checks).toHaveLength(3) // downstream checks are pointless until the basics pass
    for (const c of checks) { expect(c.ok).toBe(false); expect(c.fix).toBeTruthy() }
  })
  it('zero peers is a connectivity failure with a hub-operator fix', () => {
    const checks = buildChecks({ installed: true, enrolled: true, running: true, peerCount: 0, serviceCount: 0, localServiceCount: 0 })
    expect(checks.find(c => c.name === 'mesh connectivity')?.ok).toBe(false)
  })
})

describe('peer expansion', () => {
  const peers = ['12D3KooWJUKLaaa', '12D3KooWHKwUbbb']
  it('exact match wins; unique prefix expands', () => {
    expect(expandPeer(peers[0]!, peers)).toEqual({ ok: true, peer: peers[0] })
    expect(expandPeer('12D3KooWHKwU', peers)).toEqual({ ok: true, peer: peers[1] })
  })
  it('ambiguous prefix lists candidates; unknown lists the roster', () => {
    const ambiguous = expandPeer('12D3KooW', peers)
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.candidates).toHaveLength(2)
    const unknown = expandPeer('zzz', peers)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.candidates).toEqual([...peers].sort())
  })
  it('shortId is a stable 12-char prefix', () => {
    expect(shortId(peers[0]!).startsWith('12D3KooWJUKL')).toBe(true)
  })
})

describe('token handoff', () => {
  it('formats an ssh one-liner that writes a 0600 token file on the target', () => {
    const line = formatSshHandoff('sam-bt-abc123', 'alice@box')
    expect(line).toBe(`ssh alice@box "printf '%s' 'sam-bt-abc123' > ~/sam-join-token && chmod 600 ~/sam-join-token"`)
  })
})

describe('parseWatch', () => {
  it('extracts status, cursor, and events from a task_watch payload', () => {
    const w = parseWatch({ task: { status: 'running' }, cursor: 'c2', events: [{ seq: 2 }] })
    expect(w).toEqual({ status: 'running', cursor: 'c2', terminal: false, events: [{ seq: 2 }] })
  })
  it('terminal statuses end the loop', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'expired']) {
      expect(parseWatch({ task: { status } }).terminal).toBe(true)
    }
    expect(parseWatch({ task: { status: 'queued' } }).terminal).toBe(false)
  })
  it('tolerates garbage input', () => {
    expect(parseWatch(null)).toEqual({ status: undefined, cursor: undefined, terminal: false, events: [] })
  })
})

describe('withCapability', () => {
  it('injects the capability without mutating the original args', () => {
    const args = { taskId: 't1' }
    const out = withCapability(args, 'secret')
    expect(out).toEqual({ taskId: 't1', _capability: 'secret' })
    expect(args).toEqual({ taskId: 't1' })
  })
  it('passes args through untouched when no capability is configured', () => {
    expect(withCapability({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(withCapability({ a: 1 }, '')).toEqual({ a: 1 })
  })
})

const INVITE: FleetInvite = {
  version: 1, controlPlane: 'https://hub.sam-mesh.dev', serviceName: 'fleet-tasks',
  capability: 'a]'.padEnd(48, '0').replace(']', '1'), announcePrivate: false, createdAt: '2026-08-26T00:00:00Z',
}

describe('fleet invite', () => {
  it('round-trips through encode/decode', () => {
    const decoded = decodeFleetInvite(encodeFleetInvite(INVITE))
    expect(decoded).toEqual(INVITE)
  })
  it('rejects garbage with a reason', () => {
    expect(decodeFleetInvite('not json')).toHaveProperty('error')
    expect(decodeFleetInvite('{"version":2}')).toHaveProperty('error')
    expect(decodeFleetInvite('{"version":1,"controlPlane":"ftp://x"}')).toHaveProperty('error')
  })
})

describe('fleetJoinEnrollment', () => {
  it('enrolls fresh machines, skips same-hub, demands reset for hub moves', () => {
    expect(fleetJoinEnrollment(false, null, INVITE)).toEqual({ action: 'enroll' })
    expect(fleetJoinEnrollment(true, 'https://hub.sam-mesh.dev/', INVITE)).toEqual({ action: 'none' })
    const move = fleetJoinEnrollment(true, 'http://192.168.50.17:8480', INVITE)
    expect(move.action).toBe('reset-required')
    if (move.action === 'reset-required') expect(move.currentHub).toContain('192.168.50.17')
  })
})

describe('mergeCredentialRefs', () => {
  it('creates a v1 file from nothing', () => {
    const out = mergeCredentialRefs(null, { MESH_TASK_CAPABILITY: 'abc' })
    expect(out).toContain('version: 1')
    expect(out).toContain('refs:')
    expect(out).toContain('  MESH_TASK_CAPABILITY: abc')
  })
  it('never overwrites existing keys, appends missing ones', () => {
    const existing = 'version: 1\nrefs:\n  SAM_NODE_AUTH: mine\n'
    const out = mergeCredentialRefs(existing, { SAM_NODE_AUTH: 'theirs', MESH_TASK_CAPABILITY: 'abc' })
    expect(out).toContain('  SAM_NODE_AUTH: mine')
    expect(out).not.toContain('SAM_NODE_AUTH: theirs')
    expect(out).toContain('  MESH_TASK_CAPABILITY: abc')
  })
  it('is idempotent', () => {
    const once = mergeCredentialRefs(null, { A: '1' })
    expect(mergeCredentialRefs(once, { A: '1' })).toBe(once)
  })
})

describe('mergeProfilePatch', () => {
  it('writes a fresh patch when none exists', () => {
    const out = mergeProfilePatch(null, INVITE)
    expect(out).toHaveProperty('text')
    if ('text' in out) {
      expect(out.text).toContain('nodeControlPlane: https://hub.sam-mesh.dev')
      expect(out.text).toContain('nodeAnnouncePrivate: false')
      expect(out.text).toContain('serviceName: fleet-tasks')
      expect(out.text).toContain('capabilityCredentialRef: MESH_TASK_CAPABILITY')
      expect(out.text).toContain('callCapabilityRef: MESH_TASK_CAPABILITY')
      expect(out.text).toContain('capabilityCredentialRef: MESH_TASK_CAPABILITY')
      expect(out.text).toMatch(/id: agent-mesh-llm[\s\S]*capabilityCredentialRef: MESH_TASK_CAPABILITY/)
      expect(out.text).toMatch(/id: agent-mesh-tools[\s\S]*serviceName: fleet-tasks/)
    }
  })
  it('appends to a patch that has no agent-mesh rows', () => {
    const out = mergeProfilePatch('- id: something-else\n  config: {}\n', INVITE)
    expect(out).toHaveProperty('text')
    if ('text' in out) expect(out.text).toContain('id: something-else')
  })
  it('refuses to clobber existing agent-mesh rows — hands the block back', () => {
    const out = mergeProfilePatch('- id: agent-mesh\n  config:\n    foo: bar\n', INVITE)
    expect(out).toHaveProperty('conflict')
  })
})

describe('buildChecks inference rows', () => {
  const base = { installed: true, enrolled: true, running: true, peerCount: 3, serviceCount: 1, localServiceCount: 1 }
  it('runtime unavailable fails with a fix; store reports detail; serve rows map states', () => {
    const checks = buildChecks({ ...base, runtimeTag: null, modelStore: { count: 2, bytes: 3e9 }, serveRows: [
      { name: 'good', state: 'serving' },
      { name: 'loading', state: 'starting', detail: 'loading smol' },
      { name: 'broken', state: 'error', detail: 'port busy' },
    ] })
    expect(checks.find(c => c.name === 'vendored llama.cpp runtime')).toMatchObject({ ok: false })
    expect(checks.find(c => c.name === 'vendored llama.cpp runtime')?.fix).toMatch(/reinstall/)
    expect(checks.find(c => c.name === 'model store')).toMatchObject({ ok: true, detail: '2 models, 3.0 GB' })
    expect(checks.find(c => c.name === "serve row 'good'")?.ok).toBe(true)
    expect(checks.find(c => c.name === "serve row 'loading'")?.fix).toMatch(/still loading/)
    expect(checks.find(c => c.name === "serve row 'broken'")?.fix).toMatch(/port busy/)
    const rendered = renderDoctor(checks)
    expect(rendered).toContain("serve row 'broken'")
  })
})
