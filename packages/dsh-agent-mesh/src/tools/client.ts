
import { defaultObservability, type MeshObservability } from '../observability/index.js'
import { mcpToolUri, parseMcpToolUri, toolIdentity } from './identity.js'
import type {
  CallToolOptions, CallToolResult, Completeness, DescribeToolOptions, DiscoveryFailure,
  DiscoverToolsOptions, JsonObject, JsonSchema, RequiredLabelsAnyOf, ToolDescription,
  ToolSearchResult, ToolSummary,
} from './types.js'

export interface ToolClientCore {
  findRemoteTools(filter?: Record<string, string>, signal?: AbortSignal): Promise<unknown>
  describeRemoteTool(input: { peer_id: string; tool_name: string }, signal?: AbortSignal): Promise<unknown>
  callRemoteTool(input: { peer_id: string; tool_name: string; arguments: Record<string, unknown>; required_labels?: string }, signal?: AbortSignal): Promise<unknown>
}

export class ToolClientError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = new.target.name }
}
export class ToolPolicyError extends ToolClientError { readonly code = 'POLICY_DENIED' }
export class ToolConnectivityError extends ToolClientError { readonly code = 'CONNECTIVITY_FAILED' }
export class ToolProtocolError extends ToolClientError { readonly code = 'PROTOCOL_ERROR' }
export class ToolNotFoundError extends ToolClientError { readonly code = 'TOOL_NOT_FOUND' }

interface CachedSchema { value: ToolDescription; expiresAt: number }
export interface ToolClientOptions { schemaTtlMs?: number; now?: () => number; /** Resolve the fleet capability per call — provisioning takes effect without a restart. */ resolveCapability?: () => Promise<string | undefined>; observability?: MeshObservability }

type WireTool = {
  peer_id?: unknown; tool_name?: unknown; description?: unknown;
  labels?: unknown; error?: unknown; input_schema?: unknown; output_schema?: unknown
}

export class ToolClient {
  readonly #cache = new Map<string, CachedSchema>()
  readonly #ttl: number
  readonly #resolveCapability: (() => Promise<string | undefined>) | undefined
  readonly #now: () => number
  readonly #observability: MeshObservability
  constructor(readonly core: ToolClientCore, options: ToolClientOptions = {}) {
    this.#ttl = options.schemaTtlMs ?? 300_000
    this.#now = options.now ?? Date.now
    this.#resolveCapability = options.resolveCapability
    this.#observability = options.observability ?? defaultObservability
  }

  async discover(options: DiscoverToolsOptions = {}, signal?: AbortSignal): Promise<ToolSearchResult> {
    const request: Record<string, string> = {}
    if (options.intent !== undefined) request.intent = options.intent
    if (options.peerId !== undefined) request.peer_id = options.peerId
    if (options.serviceName !== undefined) request.service_name = normalizeService(options.serviceName)
    if (options.toolName !== undefined) request.tool_name = options.toolName
    let wire: unknown
    try { wire = await this.core.findRemoteTools(request, signal) }
    catch (error) { throw mapToolError(error) }
    const result = normalizeSearch(wire)
    this.#observability.record('discovery', { operation: 'tools', outcome: result.complete ? 'ok' : result.partial ? 'partial' : 'error', completeness: result.complete ? 'complete' : result.partial ? 'partial' : 'failed' })
    return result
  }

  find(options: DiscoverToolsOptions = {}, signal?: AbortSignal): Promise<ToolSearchResult> { return this.discover(options, signal) }

  async describe(peerId: string, uri: string, options: DescribeToolOptions = {}, signal?: AbortSignal): Promise<ToolDescription> {
    const identity = toolIdentity(peerId, uri)
    const key = cacheKey(peerId, identity.uri)
    const now = this.#now()
    const cached = this.#cache.get(key)
    const maxAge = options.maxAgeMs ?? this.#ttl
    if (!options.force && cached && now - cached.value.schemaFetchedAt <= maxAge) {
      return { ...cached.value, fromCache: true }
    }
    let wire: unknown
    try { wire = await this.core.describeRemoteTool({ peer_id: peerId, tool_name: identity.uri }, signal) }
    catch (error) { throw mapToolError(error) }
    const row = asObject(wire)
    const inputSchema = schema(row.input_schema ?? row.inputSchema)
    const description: ToolDescription = {
      ...identity,
      ...(typeof row.description === 'string' ? { description: row.description } : {}),
      inputSchema,
      ...(row.output_schema !== undefined || row.outputSchema !== undefined
        ? { outputSchema: schema(row.output_schema ?? row.outputSchema) } : {}),
      schemaFetchedAt: now,
      fromCache: false,
    }
    this.#cache.set(key, { value: description, expiresAt: now + this.#ttl })
    return description
  }

  async call(peerId: string, uri: string, arguments_: JsonObject = {}, options: CallToolOptions = {}, signal?: AbortSignal): Promise<CallToolResult> {
    const identity = toolIdentity(peerId, uri)
    if (options.revalidateSchema !== false) {
      await this.describe(peerId, uri, { maxAgeMs: options.schemaMaxAgeMs ?? this.#ttl }, signal)
    }
    const request: Record<string, unknown> = { peer_id: peerId, tool_name: identity.uri, arguments: arguments_ }
    const required = encodeRequiredLabels(options.requiredLabelsAnyOf)
    // Fleet capability: injected BELOW the dsh tool layer so it never lands
    // in dsh's tool-call journal (the user-facing args stay clean), and the
    // service edge strips it before handlers or schema validation see it —
    // always-inject is safe even for open tools. resolveCapability runs per
    // call so pairing/provisioning takes effect without a restart.
    const capability = this.#resolveCapability ? await this.#resolveCapability() : undefined
    const wireArgs = { ...arguments_ as Record<string, unknown>, ...(capability !== undefined ? { _capability: capability } : {}) }
    const callRequest = { peer_id: peerId, tool_name: identity.uri, arguments: wireArgs, ...(required ? { required_labels: required } : {}) }
    try { return await this.core.callRemoteTool(callRequest, signal) as CallToolResult }
    catch (error) { throw mapToolError(error) }
  }

  invalidate(peerId?: string, uri?: string): void {
    if (peerId && uri) this.#cache.delete(cacheKey(peerId, parseMcpToolUri(uri).uri))
    else if (peerId) for (const key of this.#cache.keys()) if (key.startsWith(`${peerId}\0`)) this.#cache.delete(key)
    else this.#cache.clear()
  }
}

export const SamToolsClient = ToolClient

function normalizeSearch(value: unknown): ToolSearchResult {
  const rows = Array.isArray(value) ? value : Array.isArray(asObject(value).tools) ? asObject(value).tools as unknown[] : []
  const tools: ToolSummary[] = []
  const failures: DiscoveryFailure[] = []
  for (const item of rows) {
    const row = asObject(item) as WireTool
    if (typeof row.error === 'string' && row.error) {
      failures.push({ ...(typeof row.peer_id === 'string' ? { peerId: row.peer_id } : {}), message: row.error })
      continue
    }
    if (typeof row.peer_id !== 'string' || typeof row.tool_name !== 'string') {
      failures.push({ message: 'Malformed tool catalogue row', code: 'PROTOCOL_ERROR' }); continue
    }
    try {
      const id = toolIdentity(row.peer_id, row.tool_name)
      tools.push({ ...id, ...(typeof row.description === 'string' ? { description: row.description } : {}),
        ...(isStringRecord(row.labels) ? { labels: row.labels } : {}) })
    } catch (error) { failures.push({ peerId: row.peer_id, message: errorMessage(error), code: 'PROTOCOL_ERROR' }) }
  }
  return { tools, complete: failures.length === 0, partial: failures.length > 0 && tools.length > 0, failures }
}

function normalizeService(value: string): string {
  if (value.startsWith('mcp://')) {
    const name = value.slice(6)
    if (!name || name.includes('/')) throw new TypeError(`Invalid MCP service: ${value}`)
    return value
  }
  return value
}
function encodeRequiredLabels(value?: RequiredLabelsAnyOf): string | undefined {
  if (!value || (Array.isArray(value) && value.length === 0)) return undefined
  const pairs: string[] = []
  if (isLabelArray(value)) for (const item of value) {
    if (typeof item === 'string') {
      if (!/^[^=,]+=[^,]+$/.test(item)) throw new TypeError(`Invalid required label: ${item}`)
      pairs.push(item)
    } else pairs.push(labelPair(item.key, item.value))
  }
  else for (const [key, val] of Object.entries(value)) pairs.push(labelPair(key, val))
  return pairs.join(',')
}
function isLabelArray(value: RequiredLabelsAnyOf): value is readonly (import('./types.js').RequiredLabel | string)[] { return Array.isArray(value) }
function labelPair(key: string, value: string): string {
  if (!key || !value || /[=,]/.test(key) || /,/.test(value)) throw new TypeError('Label keys/values cannot be empty or contain separators')
  return `${key}=${value}`
}
function mapToolError(error: unknown): ToolClientError {
  if (error instanceof ToolClientError) return error
  const text = diagnosticText(error)
  const opts = error instanceof Error ? { cause: error } : undefined
  if (/policy|denied|forbidden|required.?labels|attest|biscuit|gater disallows/i.test(text)) return new ToolPolicyError(text, opts)
  if (/connect|dial|unreachable|timeout|timed out|socket|network|relay|peer.*offline/i.test(text)) return new ToolConnectivityError(text, opts)
  if (/not found|unknown tool/i.test(text)) return new ToolNotFoundError(text, opts)
  return new ToolProtocolError(text, opts)
}
function cacheKey(peerId: string, uri: string): string { return `${peerId}\0${uri}` }
function asObject(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {} }
function schema(value: unknown): JsonSchema {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ToolProtocolError('Remote tool returned an invalid JSON schema')
  return value as JsonSchema
}
function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(v => typeof v === 'string')
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function diagnosticText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const details: unknown[] = [error.message]
  const record = error as Error & { payload?: unknown; data?: unknown; body?: unknown; cause?: unknown }
  for (const value of [record.payload, record.data, record.body]) if (value !== undefined) {
    try { details.push(JSON.stringify(value)) } catch { details.push(String(value)) }
  }
  if (record.cause !== undefined) details.push(diagnosticText(record.cause))
  return details.join(': ')
}
