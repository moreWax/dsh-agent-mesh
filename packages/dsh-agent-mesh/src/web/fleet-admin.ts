/**
 * Fleet administration, extracted from the web host (host decomposition):
 * the request queue, approvals, member registry, and invite codes. The host
 * keeps thin @Remote wrappers that delegate here; the wire surface is
 * unchanged. All calls ride the fleet server's operator tools through the
 * mesh — the capability IS the operator credential.
 */
import { toolPayload, type AgentMeshFace } from '@morewax/sam-mesh'

export interface FleetAdminProvider { peerId: string; service: string; capability: string }

export class FleetAdminOps {
  constructor(private readonly mesh: AgentMeshFace) {}

  async requests(provider: FleetAdminProvider): Promise<{ pending: { requestId: string; label: string; requestedAt?: string }[] }> {
    const result = toolPayload<{ pending?: { requestId: string; label: string; requestedAt?: string }[] }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_pair_list`, arguments: { _capability: provider.capability } }))
    return { pending: Array.isArray(result.pending) ? result.pending : [] }
  }

  async approve(provider: FleetAdminProvider, requestId: string, approvedBy: string): Promise<{ label?: string }> {
    return toolPayload<{ label?: string }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_pair_approve`, arguments: { _capability: provider.capability, requestId, approvedBy } }))
  }

  async reject(provider: FleetAdminProvider, requestId: string): Promise<void> {
    await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_pair_reject`, arguments: { _capability: provider.capability, requestId } })
  }

  async members(provider: FleetAdminProvider): Promise<{ members: { id: string; name: string; scopes: string[]; createdAt: string; note?: string }[] }> {
    const result = toolPayload<{ members?: { id: string; name: string; scopes: string[]; createdAt: string; note?: string }[] }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_member_list`, arguments: { _capability: provider.capability } }))
    return { members: Array.isArray(result.members) ? result.members : [] }
  }

  async revoke(provider: FleetAdminProvider, id: string): Promise<void> {
    await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_member_revoke`, arguments: { _capability: provider.capability, id } })
  }

  async inviteCreate(provider: FleetAdminProvider, options: { ttlMs?: number; note?: string }): Promise<{ code?: string; expiresAt?: number }> {
    return toolPayload<{ code?: string; expiresAt?: number }>(await this.mesh.core.callRemoteTool({ peer_id: provider.peerId, tool_name: `mcp://${provider.service}/fleet_invite_create`, arguments: { _capability: provider.capability, ...(options.ttlMs ? { ttlMs: options.ttlMs } : {}), ...(options.note ? { note: options.note } : {}) } }))
  }
}
