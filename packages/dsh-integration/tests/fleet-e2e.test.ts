/**
 * Two-service integration harness: a real fleet server (task service with
 * pairing, members, invite codes, chat tools) + a real DM inbox, driven over
 * the ACTUAL HTTP wire (JSON-RPC envelopes included) by a fake mesh client.
 * This is the regression net for the bug classes that burned us live:
 * envelope drift, single-use consumption, member attribution, scope denial,
 * invite-code single-use.
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { generatePairKeys, open } from '@morewax/sam-mesh'
import { TaskService, InMemoryTaskStore } from '@morewax/dsh-agent-mesh/tasks'
import { TaskHttpServer } from '@morewax/dsh-agent-mesh/tasks'
import { withPairing, InviteCodes, PairingStore } from '@morewax/dsh-agent-mesh/tasks'
import { FleetMemberRegistry, MemberAuthorizer, withMemberTools } from '@morewax/dsh-agent-mesh/tasks'
import { SQLiteChatStore } from '@morewax/dsh-mesh-chat/store'
import { registerFleetChatTools } from '@morewax/dsh-mesh-chat/fleet-channel'
import { createInboxServer } from '@morewax/dsh-mesh-chat/inbox'

function listen(server: Server): Promise<string> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`)
  }))
}

/** Fake mesh client: routes tool calls to REAL services over the REAL wire. */
function fakeMesh(routes: Record<string, string>) {
  return {
    async callRemoteTool(input: { peer_id: string; tool_name: string; arguments: Record<string, unknown> }): Promise<unknown> {
      const match = /mcp:\/\/([^/]+)\/(.+)$/.exec(input.tool_name)
      if (!match) throw new Error(`bad tool_name: ${input.tool_name}`)
      const base = routes[match[1]!]
      if (!base) throw new Error(`no route for service ${match[1]}`)
      const res = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: match[2], arguments: input.arguments } }),
      })
      const body = await res.json() as { result?: unknown; error?: { message: string } }
      if (body.error) throw new Error(body.error.message)
      return body.result
    },
  }
}

describe('fleet e2e over the wire', () => {
  it('invite join → member chat send (attributed) → fetch with system events → DM → revoke → denied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'e2e-'))
    const chatStore = new SQLiteChatStore(join(dir, 'chat.db'))
    const members = new FleetMemberRegistry(join(dir, 'members.json'))
    const OPERATOR = 'operator-secret-' + 'x'.repeat(32)
    const invites = new InviteCodes()

    // ── the fleet server: task service + pairing + member tools + chat tools
    const service = new TaskService(new InMemoryTaskStore(), { async execute(task) { return task.input ?? null } })
    withPairing(service, {
      invites,
      inviteFor: async (label: string, scopes?: string[]) => {
        const member = await members.add(label || 'fleet-member', (scopes?.length ? scopes : ['tasks', 'inference']) as ('tasks' | 'inference')[], 'paired')
        return JSON.stringify({ version: 1, controlPlane: 'https://hub.sam-mesh.dev', serviceName: 'dsh-task-service', capability: member.capability, scopes: member.scopes })
      },
    })
    withMemberTools(service, members)
    registerFleetChatTools(service as never, chatStore)
    const http = new TaskHttpServer(service, {
      authorizers: [new MemberAuthorizer(async () => (await members.list()).map(m => ({ capability: m.capability, name: m.name, scopes: m.scopes })), OPERATOR)],
      onAudit: event => chatStore.append('fleet', { kind: 'system', sender: 'system', text: `${event.tool} ${event.allowed ? 'allowed' : 'DENIED'}${event.member ? ` — ${event.member}` : ''}` }),
    })
    const fleetAddress = await http.start()
    const fleetUrl = fleetAddress.mcpUrl.replace(/\/mcp$/, '')
    const inboxStore = new SQLiteChatStore(join(dir, 'inbox.db'))
    const inboxServer = createInboxServer(inboxStore, {})
    const inboxUrl = await listen(inboxServer)

    const mesh = fakeMesh({ 'dsh-task-service': fleetUrl, 'dsh-chat-inbox': inboxUrl })

    // ── operator mints a code; the joiner consumes it (no approval round-trip)
    const created = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_invite_create', arguments: { _capability: OPERATOR } })) as { structuredContent: { code: string } }
    const code = created.structuredContent.code

    const joiner = generatePairKeys()
    const requestId = 'e2e-' + Date.now().toString(16) + 'abcdef'
    const req = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_pair_request', arguments: { requestId, publicKey: joiner.publicKeyX, label: 'e2e-joiner', inviteCode: code } })) as { structuredContent: { accepted: boolean; autoApproved?: string } }
    expect(req.structuredContent.autoApproved).toBe('invite-code')

    const poll = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_pair_poll', arguments: { requestId } })) as { structuredContent: { state: string; sealed: Parameters<typeof open>[0] } }
    const invite = JSON.parse(open(poll.structuredContent.sealed, joiner.privateKey)) as { capability: string }
    const memberCap = invite.capability

    // ── the member chats; attribution lands; system events include the flow
    await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/chat_send', arguments: { _capability: memberCap, text: 'hello from the integration harness' } })
    const page = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/chat_fetch', arguments: { _capability: memberCap } })) as { structuredContent: { messages: Array<{ kind: string; sender: string; text: string }> } }
    const kinds = page.structuredContent.messages
    expect(kinds.some(m => m.kind === 'user' && m.sender === 'e2e-joiner' && m.text.includes('integration harness'))).toBe(true)
    expect(kinds.some(m => m.kind === 'system' && m.text.includes('fleet_pair_request'))).toBe(true)

    // ── a DM into the inbox
    const dm = (await mesh.callRemoteTool({ peer_id: 'joiner', tool_name: 'mcp://dsh-chat-inbox/dm_send', arguments: { from: 'e2e-joiner', text: 'direct hello' } })) as { structuredContent: { delivered: boolean } }
    expect(dm.structuredContent.delivered).toBe(true)
    expect(inboxStore.fetch('inbox')[0]!.text).toBe('direct hello')

    // ── revoke: the member's next call is denied
    const list = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_member_list', arguments: { _capability: OPERATOR } })) as { structuredContent: { members: Array<{ id: string }> } }
    const memberId = list.structuredContent.members.find(() => true)!.id
    await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_member_revoke', arguments: { _capability: OPERATOR, id: memberId } })
    await expect(mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/chat_send', arguments: { _capability: memberCap, text: 'am I still here?' } })).rejects.toThrow(/capability/)

    // ── re-pair (D1): a fresh invite code admits the same machine as a NEW member
    const created2 = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_invite_create', arguments: { _capability: OPERATOR } })) as { structuredContent: { code: string } }
    const joiner2 = generatePairKeys()
    const requestId2 = 'e2e2-' + Date.now().toString(16) + 'abcdef'
    const req2 = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_pair_request', arguments: { requestId: requestId2, publicKey: joiner2.publicKeyX, label: 'e2e-joiner-repaired', inviteCode: created2.structuredContent.code } })) as { structuredContent: { autoApproved?: string } }
    expect(req2.structuredContent.autoApproved).toBe('invite-code')
    const poll2 = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/fleet_pair_poll', arguments: { requestId: requestId2 } })) as { structuredContent: { state: string; sealed: Parameters<typeof open>[0] } }
    const invite2 = JSON.parse(open(poll2.structuredContent.sealed, joiner2.privateKey)) as { capability: string }
    await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/chat_send', arguments: { _capability: invite2.capability, text: 'back from revocation' } })
    const page2 = (await mesh.callRemoteTool({ peer_id: 'fleet', tool_name: 'mcp://dsh-task-service/chat_fetch', arguments: { _capability: invite2.capability } })) as { structuredContent: { messages: Array<{ sender: string; text: string }> } }
    expect(page2.structuredContent.messages.some(m => m.sender === 'e2e-joiner-repaired' && m.text === 'back from revocation')).toBe(true)

    http.stop(); inboxServer.close(); chatStore.close(); inboxStore.close()
  })
})
