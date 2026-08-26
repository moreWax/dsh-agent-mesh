import { describe, expect, it } from 'vitest'
import { buildChecks, expandPeer, formatMintBlock, formatSshHandoff, nextJoinStep, parseWatch, renderDoctor, shortId } from '../src/cli/plan.js'

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
