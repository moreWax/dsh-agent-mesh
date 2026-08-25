/** Project SAM remote MCP tools into the DeepSeek Harness tool registry. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import type { AgentMeshService } from '../index.js'
import type { CallToolResult, RequiredLabelsAnyOf, ToolDescription, ToolSummary } from '../tools/index.js'

const MAX_NAME = 64
const INVALID_NAME = /[^A-Za-z0-9_-]/g
const HASH_LENGTH = 12

export interface ToolsProviderConfig {
  /** Discovery filters forwarded to SAM. */
  intent?: string
  peerId?: string
  serviceName?: string
  toolName?: string
  /** SAM's current label policy is any-of. */
  requiredLabelsAnyOf?: RequiredLabelsAnyOf
  /** Zero disables periodic refresh. */
  refreshIntervalMs?: number
  /** Fail activation rather than retaining an empty generation. */
  failOnStartupError?: boolean
}

export interface ProjectedIdentity { name: string; peerId: string; uri: string }

/** Stable public identity. The hash always commits to both peer and canonical URI. */
export function projectedToolName(peerId: string, uri: string): string {
  const tool = uri.split('/').filter(Boolean).at(-1) ?? 'tool'
  const peer = peerId.slice(0, 12) || 'peer'
  const prefix = `sam__${peer}__${tool}`.replace(INVALID_NAME, '_')
  const hash = createHash('sha256').update(`${peerId}\0${uri}`).digest('hex').slice(0, HASH_LENGTH)
  return `${prefix.slice(0, MAX_NAME - HASH_LENGTH - 1)}_${hash}`
}

export class SamToolPolicyError extends Error {
  readonly code = 'SAM_POLICY_DENIED'
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = 'SamToolPolicyError' }
}

interface Generation { definitions: Map<string, ToolDefinition>; disposers: Map<string, () => void> }
interface ToolsRegistry { register(definition: ToolDefinition): () => void }
type ProviderContext = Context & { tools: ToolsRegistry; agentMesh: AgentMeshService }

/** Owns refresh serialization and generation swaps; exported for focused tests/operators. */
export class SamToolsProvider {
  #generation: Generation = { definitions: new Map(), disposers: new Map() }
  #refreshing: Promise<void> | undefined
  #stopped = false
  readonly #lifecycle = new AbortController()

  constructor(private readonly ctx: ProviderContext, private readonly config: ToolsProviderConfig = {}) {}

  refresh(): Promise<void> {
    if (this.#stopped) return Promise.reject(new Error('SAM tools provider is disposed'))
    if (!this.#refreshing) {
      const pending = this.#buildAndSwap()
      const tracked = pending.finally(() => { if (this.#refreshing === tracked) this.#refreshing = undefined })
      this.#refreshing = tracked
    }
    return this.#refreshing
  }

  async #buildAndSwap(): Promise<void> {
    const signal = this.#lifecycle.signal
    const found = await this.ctx.agentMesh.tools.find({
      ...(this.config.intent !== undefined ? { intent: this.config.intent } : {}),
      ...(this.config.peerId !== undefined ? { peerId: this.config.peerId } : {}),
      ...(this.config.serviceName !== undefined ? { serviceName: this.config.serviceName } : {}),
      ...(this.config.toolName !== undefined ? { toolName: this.config.toolName } : {}),
    }, signal)
    if (!found.complete) {
      throw new Error(`SAM tool discovery incomplete: ${found.failures.map(item => item.message).join('; ')}`)
    }

    // Describe is deliberately mandatory and completes before registry mutation.
    const described = await Promise.all(found.tools.map(tool =>
      this.ctx.agentMesh.tools.describe(tool.peerId, tool.uri, { force: true }, signal)))
    if (signal.aborted) throw abortError()
    const definitions = new Map<string, ToolDefinition>()
    for (let index = 0; index < described.length; index++) {
      const description = described[index]!
      const summary = found.tools[index]!
      const name = projectedToolName(description.peerId, description.uri)
      if (definitions.has(name)) throw new Error(`SAM projected tool identity collision: ${name}`)
      definitions.set(name, createDefinition(this.ctx.agentMesh, summary, description, name, this.config.requiredLabelsAnyOf))
    }

    const previous = this.#generation
    for (const dispose of previous.disposers.values()) dispose()
    const next: Generation = { definitions, disposers: new Map() }
    try {
      for (const [name, definition] of definitions) next.disposers.set(name, this.ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of next.disposers.values()) dispose()
      // Roll back the complete prior generation on a registration conflict.
      const restored: Generation = { definitions: previous.definitions, disposers: new Map() }
      try {
        for (const [name, definition] of previous.definitions) restored.disposers.set(name, this.ctx.tools.register(definition))
        this.#generation = restored
      } catch (rollback) {
        for (const dispose of restored.disposers.values()) dispose()
        this.#generation = { definitions: new Map(), disposers: new Map() }
        throw new AggregateError([error, rollback], 'SAM tool generation swap and rollback failed')
      }
      throw error
    }
    this.#generation = next
  }

  dispose(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#lifecycle.abort()
    for (const dispose of this.#generation.disposers.values()) dispose()
    this.#generation = { definitions: new Map(), disposers: new Map() }
  }
}

function createDefinition(mesh: AgentMeshService, summary: ToolSummary, description: ToolDescription, name: string, labels?: RequiredLabelsAnyOf): ToolDefinition {
  assertSupportedJsonSchema(description.inputSchema)
  const outputSchema = supportedSchema(description.outputSchema)
  return {
    name,
    description: description.description ?? summary.description ?? `SAM remote tool ${description.uri} on ${description.peerId}`,
    parameters: description.inputSchema,
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} }, structuredContent: outputSchema ?? {} },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args: unknown, value: JsonValue) {
        const result = value as { content: unknown[]; structuredContent?: unknown }
        return [{ type: 'text', text: projectText(result, description.uri) }]
      },
    },
    async execute(args, exec) {
      const object = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, JsonValue> : {}
      try {
        const result = await mesh.tools.call(description.peerId, description.uri, object, {
          ...(labels === undefined ? {} : { requiredLabelsAnyOf: labels }),
          revalidateSchema: true,
        }, exec.signal)
        if (result.isError) throw new Error(projectText(result, description.uri))
        return jsonResult(result)
      } catch (error) {
        if (isPolicyFailure(error)) throw new SamToolPolicyError(`SAM policy denied ${description.peerId} ${description.uri}: ${message(error)}`, { cause: error })
        throw error
      }
    },
  }
}

function supportedSchema(value: unknown): JsonSchemaNode | undefined {
  if (value === undefined) return undefined
  try { assertSupportedJsonSchema(value); return value as JsonSchemaNode } catch { return undefined }
}
function jsonResult(result: CallToolResult): JsonValue {
  const projected = { content: result.content, ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }) }
  try { return JSON.parse(JSON.stringify(projected)) as JsonValue }
  catch (cause) { throw new Error('SAM tool returned a non-JSON result', { cause }) }
}
function projectText(result: { content?: readonly unknown[]; structuredContent?: unknown }, uri: string): string {
  const texts = (result.content ?? []).flatMap(block => {
    if (typeof block !== 'object' || block === null) return []
    const value = block as Record<string, unknown>
    return value.type === 'text' && typeof value.text === 'string' ? [value.text] : []
  })
  if (texts.length) return texts.join('\n')
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return `${uri} completed with no text output`
}
function isPolicyFailure(error: unknown): boolean { return /policy|denied|forbidden|required.?labels|attest|biscuit|gater disallows/i.test(message(error)) }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function abortError(): Error { const error = new Error('SAM tools refresh aborted'); error.name = 'AbortError'; return error }
