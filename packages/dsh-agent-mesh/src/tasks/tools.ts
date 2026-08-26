/**
 * Tool descriptors: ONE registration per tool, every surface derives from it
 * — MCP dispatch, tools/list advertising, the authorization layer, and docs.
 *
 * The pre-registry design scattered each tool across four places (dispatch
 * switch, schema map, description map, gate-exemption set). The exemption
 * set was the dangerous one: auth drift between "what a tool is" and "what
 * the gate protects" is a security bug class, not a style issue. Auth is now
 * declared ON the tool; the gate reads the declaration.
 */
import type { JsonObject } from './types.js'

/**
 * - open:       callable without credentials BY DESIGN (pairing bootstrap —
 *               the tool carries its own security argument)
 * - capability: requires the fleet capability
 * - operator:   capability-gated AND semantics are fleet-admin (approvals,
 *               registration) — reserved for future scoped tokens that may
 *               hold capability without operator rights
 */
export type ToolAuth = 'open' | 'capability' | 'operator'

export interface ToolContext { signal?: AbortSignal | undefined }

export interface ToolDescriptor {
  name: string
  description: string
  /** JSON Schema for the arguments object; advertised verbatim via tools/list. */
  schema: Record<string, unknown>
  auth: ToolAuth
  handler(args: JsonObject, ctx: ToolContext): Promise<unknown>
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDescriptor>()

  register(tool: ToolDescriptor): this {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool registration: ${tool.name}`)
    if (!tool.name || !tool.schema || typeof tool.handler !== 'function') throw new Error(`invalid tool descriptor: ${tool.name || '(unnamed)'}`)
    this.tools.set(tool.name, tool)
    return this
  }

  get(name: string): ToolDescriptor | undefined { return this.tools.get(name) }

  /** The tools/list wire shape, in registration order (pins depend on it). */
  list(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.tools.values()].map(t => ({ name: t.name, description: t.description, inputSchema: t.schema }))
  }

  get size(): number { return this.tools.size }
}
