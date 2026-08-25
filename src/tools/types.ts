
/** JSON values accepted as MCP arguments and results. */
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }
export type JsonSchema = Record<string, unknown>

export interface RequiredLabel { key: string; value: string }
export type RequiredLabelsAnyOf = readonly (RequiredLabel | string)[] | Readonly<Record<string, string>>

export interface ToolIdentity { peerId: string; serviceName: string; toolName: string; uri: string }
export interface ToolSummary extends ToolIdentity {
  description?: string
  labels?: Readonly<Record<string, string>>
}
export interface ToolDescription extends ToolSummary {
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  schemaFetchedAt: number
  fromCache: boolean
}
export interface DiscoveryFailure { peerId?: string; message: string; code?: string }
export interface Completeness {
  complete: boolean
  partial: boolean
  failures: readonly DiscoveryFailure[]
}
export interface ToolSearchResult extends Completeness { tools: readonly ToolSummary[] }
export interface DiscoverToolsOptions {
  intent?: string
  peerId?: string
  serviceName?: string
  toolName?: string
}
export interface DescribeToolOptions { force?: boolean; maxAgeMs?: number }
export interface CallToolOptions {
  requiredLabelsAnyOf?: RequiredLabelsAnyOf
  /** Re-fetch the authoritative schema immediately before invocation. */
  revalidateSchema?: boolean
  schemaMaxAgeMs?: number
}
export interface McpContent { type: string; [key: string]: unknown }
export interface CallToolResult { content: readonly McpContent[]; isError?: boolean; structuredContent?: unknown; [key: string]: unknown }
