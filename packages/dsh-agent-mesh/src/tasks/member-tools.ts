/**
 * Operator tools for the fleet member registry: list and revoke. Operator
 * credentials only — the shared capability (or an 'admin'-scoped member).
 * Revocation is registry deletion; it takes effect on the next gated call
 * wherever the registry file is read (the task service and every inference
 * gate on this machine share ~/.config/sam-mesh/fleet-members.json).
 */
import type { FleetMemberRegistry } from './members.js'
import type { ToolDescriptor } from './tools.js'
import { TaskProtocolError, type JsonObject } from './types.js'

const memberError = (code: string, message: string, retryable = false): TaskProtocolError =>
  new TaskProtocolError({ code, message, retryable })

/** The member view returned over the wire — the capability NEVER leaves the machine. */
function publicView(members: readonly { id: string; name: string; scopes: string[]; createdAt: string; note?: string }[]) {
  return members.map(m => ({ id: m.id, name: m.name, scopes: m.scopes, createdAt: m.createdAt, ...(m.note ? { note: m.note } : {}) }))
}

export function memberTools(registry: FleetMemberRegistry): ToolDescriptor[] {
  const obj = (required: string[], properties: Record<string, unknown>): Record<string, unknown> =>
    ({ type: 'object', required, properties, additionalProperties: false })
  return [
    { name: 'fleet_member_list', description: 'List fleet members and their scopes (operator; capabilities are never returned)', auth: 'operator',
      schema: obj([], {}),
      handler: async () => ({ members: publicView(await registry.list()) }) },
    { name: 'fleet_member_revoke', description: 'Revoke a fleet member — their capability fails on the next gated call (operator)', auth: 'operator',
      schema: obj(['id'], { id: { type: 'string', minLength: 1 } }),
      handler: async (args: JsonObject) => {
        if (typeof args.id !== 'string' || !args.id) throw memberError('TASK_PROTOCOL_INVALID_REQUEST', 'id is required', false)
        const revoked = await registry.revoke(args.id)
        if (!revoked) throw memberError('TASK_MEMBER_UNKNOWN', 'No member with that id', false)
        return { revoked: true, id: args.id }
      } },
  ]
}

/** Mount member administration on any registry-bearing service. */
export function withMemberTools(service: { tools: { register(tool: ToolDescriptor): unknown } }, registry: FleetMemberRegistry): void {
  for (const tool of memberTools(registry)) service.tools.register(tool)
}
