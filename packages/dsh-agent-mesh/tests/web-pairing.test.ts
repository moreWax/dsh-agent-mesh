import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { AgentMeshWebHost } from '../src/web/host.js'
import { InMemoryTaskStore, TaskService, type TaskExecutor } from '../src/tasks/service.js'
import { withPairing } from '../src/tasks/pairing.js'
import { generatePairKeys, open } from '@morewax/sam-mesh'

const INVITE = JSON.stringify({ version: 1, controlPlane: 'https://hub.sam-mesh.dev', serviceName: 'fleet', capability: 'c'.repeat(32), announcePrivate: false })
const approval = { approved: true, approvedBy: 'test-operator' }

function host(withTasks: boolean) {
  const ctx = new Context()
  if (withTasks) {
    const service = withPairing(new TaskService(new InMemoryTaskStore(), {} as TaskExecutor), { inviteFor: () => INVITE })
    ctx.provide('agentMeshTaskService', service)
    return { host: new AgentMeshWebHost(ctx, {} as never), service }
  }
  return { host: new AgentMeshWebHost(ctx, {} as never), service: undefined }
}

describe('web pairing remotes', () => {
  it('clean empty state when the task service is unmounted or pairing unarmed', async () => {
    const { host: h } = host(false)
    expect(await h.pairRequests()).toEqual({ pairing: false, pending: [] })
    const approved = await h.approvePairRequest('x', approval)
    expect(approved.ok).toBe(false)
  })

  it('approve seals the invite to the pending requester (the in-process operator path)', async () => {
    const { host: h, service } = host(true)
    expect((await h.pairRequests()).pairing).toBe(true)
    const keys = generatePairKeys()
    service!.pairing!.request('web-req-0123456789ab', keys.publicKeyX, 'macbook')
    expect((await h.pairRequests()).pending).toHaveLength(1)
    const approved = await h.approvePairRequest('web-req-0123456789ab', approval)
    expect(approved.ok).toBe(true)
    const poll = service!.pairing!.poll('web-req-0123456789ab')
    expect(poll.state).toBe('approved')
    if (poll.state === 'approved') expect(open(poll.sealed, keys.privateKey)).toBe(INVITE)
  })

  it('reject removes the request; approvals without an approver name are refused', async () => {
    const { host: h, service } = host(true)
    service!.pairing!.request('web-rej-0123456789ab', 'dGVzdA', 'stranger-box')
    expect((await h.rejectPairRequest('web-rej-0123456789ab', approval)).ok).toBe(true)
    expect((await h.pairRequests()).pending).toHaveLength(0)
    service!.pairing!.request('web-req2-0123456789a', 'dGVzdA', 'macbook')
    const refused = await h.approvePairRequest('web-req2-0123456789a', { approved: true, approvedBy: ' ' })
    expect(refused.ok).toBe(false)
  })
})
