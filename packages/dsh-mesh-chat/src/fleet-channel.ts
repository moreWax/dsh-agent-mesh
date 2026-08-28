/**
 * The fleet channel: chat tools registered ON the fleet server's task
 * service, so they ride its announced MCP endpoint and its authorizer chain
 * (member capability; ANY-of scope chat|tasks — every fleet member can talk,
 * operators tighten later). Attribution comes from the capability → member
 * identification the service edge already performs.
 */
import type { ChatStore } from './store.js'

/** Structural task-service face — no import of @morewax/dsh-agent-mesh (trust boundary). */
export interface ToolMountService {
  tools: { register(tool: unknown): unknown }
}

export function fleetChatTools(store: ChatStore, options: { maxMessageChars?: number } = {}): unknown[] {
  const maxChars = options.maxMessageChars ?? 4000
  const obj = (required: string[], properties: Record<string, unknown>): Record<string, unknown> =>
    ({ type: 'object', required, properties, additionalProperties: false })
  const CHANNEL = 'fleet'
  return [
    { name: 'chat_send', description: 'Send a message to the fleet channel (member-gated)', auth: 'capability', requiredScopes: ['chat', 'tasks'],
      schema: obj(['text'], { text: { type: 'string', minLength: 1, maxLength: maxChars } }),
      handler: async (args: { text?: unknown }, options?: { member?: string }) => {
        const text = typeof args.text === 'string' ? args.text.trim() : ''
        if (!text) throw new Error('text is required')
        const message = store.append(CHANNEL, { kind: 'user', sender: options?.member ?? 'member', text })
        return { delivered: true, id: message.id }
      } },
    { name: 'chat_fetch', description: 'Fetch fleet channel messages after a cursor (member-gated)', auth: 'capability', requiredScopes: ['chat', 'tasks'],
      schema: obj([], { afterId: { type: 'number' }, limit: { type: 'number' } }),
      handler: async (args: { afterId?: unknown; limit?: unknown }) => {
        const afterId = typeof args.afterId === 'number' ? args.afterId : 0
        const limit = typeof args.limit === 'number' && args.limit > 0 && args.limit <= 500 ? Math.floor(args.limit) : 100
        return { messages: store.fetch(CHANNEL, afterId, limit) }
      } },
  ]
}

export function registerFleetChatTools(service: ToolMountService, store: ChatStore, options?: { maxMessageChars?: number }): void {
  for (const tool of fleetChatTools(store, options)) service.tools.register(tool)
}
