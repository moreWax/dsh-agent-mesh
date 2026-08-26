
import type { ToolIdentity } from './types.js'

const COMPONENT = /^[^/?#\s]+$/

/** Build SAM's canonical remote MCP tool name. */
export function mcpToolUri(serviceName: string, toolName: string): string {
  if (!COMPONENT.test(serviceName) || !COMPONENT.test(toolName))
    throw new TypeError('MCP service and tool names must be non-empty URI path components')
  return `mcp://${serviceName}/${toolName}`
}

/** Parse a canonical mcp://service/tool identity. Non-canonical aliases fail closed. */
export function parseMcpToolUri(uri: string): Omit<ToolIdentity, 'peerId'> {
  const match = /^mcp:\/\/([^/?#\s]+)\/([^/?#\s]+)$/.exec(uri)
  if (!match?.[1] || !match[2]) throw new TypeError(`Invalid canonical MCP tool identity: ${uri}`)
  return { serviceName: match[1], toolName: match[2], uri: mcpToolUri(match[1], match[2]) }
}

export function toolIdentity(peerId: string, uri: string): ToolIdentity {
  if (!peerId.trim()) throw new TypeError('peerId is required')
  return { peerId, ...parseMcpToolUri(uri) }
}
