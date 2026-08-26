import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AgentMeshWebHost } from '../src/web/host.js'
import { generatePairKeys, seal } from '@morewax/sam-mesh'

const INVITE = JSON.stringify({ version: 1, controlPlane: 'https://hub.sam-mesh.dev', serviceName: 'fleet-tasks', capability: 'c'.repeat(32), announcePrivate: false })
const approval = { approved: true, approvedBy: 'tester' }

function hostWith(core: Record<string, unknown>) {
  const ctx = new Context()
  const setMock = vi.fn(async () => undefined)
  ;(ctx as unknown as { credentials: unknown }).credentials = { set: setMock, resolve: async () => undefined }
  const host = new AgentMeshWebHost(ctx, { core } as never)
  return { host, setMock }
}

describe('fleet join from the card (host-owned session)', () => {
  it('fleetDiscover groups providers by service name', async () => {
    const { host } = hostWith({ discoverRemoteServices: async () => [
      { srv_name: 'fleet-tasks', peer_id: 'peer-aaa' }, { srv_name: 'fleet-tasks', peer_id: 'peer-bbb' }, { srv_name: 'other', peer_id: 'peer-ccc' },
    ] })
    const { fleets } = await host.fleetDiscover()
    expect(fleets).toContainEqual({ name: 'fleet-tasks', providers: 2, peerIds: ['peer-aaa', 'peer-bbb'] })
    expect(fleets).toContainEqual({ name: 'other', providers: 1, peerIds: ['peer-ccc'] })
  })

  it('request → poll → approved: invite opens and capability lands in the managed store', async () => {
    const joiner = generatePairKeys()
    const sealed = seal(INVITE, joiner.publicKeyX)
    // the "remote service": records the request, then returns the sealed approval
    let requested: Record<string, unknown> | undefined
    const core = {
      discoverRemoteServices: async () => [{ srv_name: 'fleet-tasks', peer_id: 'peer-aaa' }],
      callRemoteTool: async (input: { tool_name: string; arguments: Record<string, unknown> }) => {
        if (input.tool_name.endsWith('/fleet_pair_request')) { requested = input.arguments; return { accepted: true } }
        if (input.tool_name.endsWith('/fleet_pair_poll')) return { state: 'approved', sealed }
        throw new Error('unexpected tool')
      },
    }
    // the host generates its OWN keypair; we must seal to what IT sends — so
    // approve lazily: first poll captures the public key, second returns sealed
    let capturedKey: string | undefined
    core.callRemoteTool = async (input: { tool_name: string; arguments: Record<string, unknown> }) => {
      if (input.tool_name.endsWith('/fleet_pair_request')) { requested = input.arguments; capturedKey = input.arguments.publicKey as string; return { accepted: true } }
      if (input.tool_name.endsWith('/fleet_pair_poll')) {
        return capturedKey ? { state: 'approved', sealed: seal(INVITE, capturedKey) } : { state: 'pending' }
      }
      throw new Error('unexpected tool')
    }
    const { host, setMock } = hostWith(core)
    const res = await host.requestFleetPair({ serviceName: 'fleet-tasks', label: 'test-machine' }, approval)
    expect(res.ok).toBe(true)
    expect(requested?.label).toBe('test-machine')
    // wait for the polling loop to settle
    const deadline = Date.now() + 5000
    let status = await host.fleetPairStatus(res.sessionId!)
    while (status.state === 'waiting' && Date.now() < deadline) { await new Promise(r => setTimeout(r, 100)); status = await host.fleetPairStatus(res.sessionId!) }
    expect(status.state).toBe('complete')
    expect(setMock).toHaveBeenCalled()
    expect(status.notes?.join(' ')).toContain('managed store')
  }, 8000)

  it('ungated attempts are refused; unknown fleets error cleanly', async () => {
    const { host } = hostWith({ discoverRemoteServices: async () => [] })
    expect((await host.requestFleetPair({ serviceName: 'x' }, { approved: false, approvedBy: '' })).ok).toBe(false)
    expect((await host.requestFleetPair({ serviceName: 'no-such-fleet' }, approval)).error).toContain('No provider')
    expect((await host.fleetPairStatus('nope')).state).toBe('unknown')
  })
})
