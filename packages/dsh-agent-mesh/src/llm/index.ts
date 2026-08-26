/** Cordis dsh-llm provider backed by SAM's OpenAI-compatible facade. */
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials/types'
import { CallId, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SamClient } from '@morewax/sam-mesh'
import { SamInferenceClient, type ChatCompletionChunk, type ChatMessage, type InferenceRoute, type RequiredLabels } from '../inference/index.js'
import { SamHttpError, SamTransportError } from '@morewax/sam-mesh'

export const name = 'agent-mesh-llm'
export const inject = ['llm', 'credentials']
export const PROVIDER = 'sam-mesh'

export interface Config {
  socketPath?: string | false
  tcpUrl?: string
  preferSocket?: boolean
  nodeCredentialRef?: string
  route?: InferenceRoute
  /** @deprecated use requiredLabelsAnyOf */
  requiredLabels?: string[]
  requiredLabelsAnyOf?: string[]
  /** Credential ref (managed store) resolved PER CALL and sent as the x-fleet-capability header on execution. */
  capabilityCredentialRef?: string
  /** Cache duration for advisory model discovery. Zero refreshes every read. */
  modelsTtlMs?: number
  timeoutMs?: number
}
export const Config: z<Config> = z.object({
  socketPath: z.union([z.string(), z.const(false)]).default('~/.config/sam-mesh/sam.sock'),
  tcpUrl: z.string().default('http://127.0.0.1:8080'),
  preferSocket: z.boolean().default(true),
  nodeCredentialRef: z.string(),
  route: z.object({ mode: z.union(['auto', 'pinned']), localProxyUrl: z.string() }),
  requiredLabels: z.array(z.string()),
  requiredLabelsAnyOf: z.array(z.string()).default([]),
  /** Managed-store credential injected as the fleet-capability gate header on EXECUTION calls
   *  (chat/completions). Model LISTING stays open — listing is the phone book, execution is gated. */
  capabilityCredentialRef: z.string().default(''),
  modelsTtlMs: z.number().min(0).default(30_000),
  timeoutMs: z.number().min(1).default(30_000),
}) as unknown as z<Config>

interface ToolDelta { id: string; name: string; arguments: string; index: number }

function textOf(blocks: readonly ContentBlock[]): string | Array<Record<string, unknown>> {
  if (blocks.every(block => block.type === 'text')) return blocks.map(block => (block as { text: string }).text).join('')
  return blocks.flatMap((block): Array<Record<string, unknown>> => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') return [{ type: 'text', text: '[image attachment unavailable through SAM OpenAI facade]' }]
    return []
  })
}

function messages(options: GenerateOptions): ChatMessage[] {
  const out: ChatMessage[] = options.system ? [{ role: 'system', content: options.system }] : []
  for (const message of options.messages) {
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    if (toolResults.length) {
      for (const block of toolResults) if (block.type === 'tool-result') out.push({
        role: 'tool', tool_call_id: String(block.toolCallId), content: textOf(block.content),
      })
      continue
    }
    const calls = message.content.filter(block => block.type === 'tool-call')
    const wire: ChatMessage = { role: message.role, content: textOf(message.content.filter(block => block.type !== 'tool-call')) }
    if (calls.length) wire.tool_calls = calls.map(block => block.type === 'tool-call' ? {
      id: String(block.id), type: 'function', function: { name: block.name, arguments: block.arguments },
    } : undefined).filter(Boolean)
    out.push(wire)
  }
  return out
}

function failure(error: unknown): LlmError {
  let value: unknown = error
  for (let depth = 0; depth < 5 && value instanceof Error; depth++, value = value.cause) {
    if (value instanceof SamHttpError) {
      const code = value.status === 401 || value.status === 403 ? 'AUTH'
        : value.status === 429 ? 'RATE_LIMIT' : value.status >= 500 ? 'SERVER' : 'PROVIDER'
      return new LlmError(value.message, code, { status: value.status, cause: error })
    }
    if (value instanceof SamTransportError) return new LlmError(value.message, 'TRANSPORT', { cause: error })
  }
  if (error instanceof Error && error.name === 'AbortError') return new LlmError(error.message || 'SAM request aborted', 'ABORTED', { cause: error })
  return new LlmError(error instanceof Error ? error.message : String(error), 'UNKNOWN', { cause: error })
}

function usage(chunk: ChatCompletionChunk): StreamChunk | undefined {
  const raw = chunk.usage as Record<string, unknown> | undefined
  if (!raw) return undefined
  return { type: 'usage', usage: {
    inputTokens: Number(raw.prompt_tokens ?? 0), outputTokens: Number(raw.completion_tokens ?? 0),
    ...(typeof raw.reasoning_tokens === 'number' ? { reasoningTokens: raw.reasoning_tokens } : {}),
  }}
}

/** A single-attempt adapter: retries and peer failover remain owned by dsh and SAM respectively. */
export class SamLlmAdapter extends LlmAdapter {
  private modelsCache: { at: number; models: readonly LlmModelInfo[] } | undefined
  constructor(private readonly inference: SamInferenceClient, private readonly config: Config = {}, private readonly resolveCapability?: () => Promise<string | undefined>) { super() }
  override providerInfo(provider: string) { return { id: provider, name: 'SAM Mesh' } }
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'agent-mesh-llm.retryPolicy') }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const ttl = this.config.modelsTtlMs ?? 30_000
    if (this.modelsCache && Date.now() - this.modelsCache.at < ttl) return this.modelsCache.models
    try {
      const listed = await this.inference.models(this.requestOptions())
      const models = listed.data.map(model => ({ provider, id: model.id, name: typeof model.name === 'string' ? model.name : model.id, inputModalities: ['text'] as const }))
      this.modelsCache = { at: Date.now(), models }
      return models
    } catch (error) { throw failure(error) }
  }
  refreshModels(provider = PROVIDER): Promise<readonly LlmModelInfo[]> { this.modelsCache = undefined; return this.listModels(provider) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const request: Record<string, unknown> = {
      model: options.model, messages: messages(options), stream: true,
      ...(options.tools ? { tools: options.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      stream_options: { include_usage: true },
    }
    let source: AsyncIterable<ChatCompletionChunk>
    const chatOptions = this.requestOptions(options.signal)
    if (this.resolveCapability) {
      const capability = await this.resolveCapability()
      if (capability) chatOptions.serviceHeaders = { 'x-fleet-capability': capability }
    }
    try { source = await this.inference.chat(request as any, chatOptions) as unknown as AsyncIterable<ChatCompletionChunk> }
    catch (error) { throw failure(error) }
    let text = '', reasoning = ''; let textOpen = false, reasoningOpen = false
    const tools = new Map<number, ToolDelta>(); let finish = 'stop'
    try {
      for await (const chunk of source) {
        const u = usage(chunk); if (u) { yield u; continue }
        for (const choice of chunk.choices as Array<Record<string, any>>) {
          finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : finish
          const delta = choice.delta ?? {}
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            if (!reasoningOpen) { reasoningOpen = true; yield { type: 'block-start', index: 0, blockType: 'reasoning' } }
            reasoning += delta.reasoning_content; yield { type: 'reasoning-delta', index: 0, text: delta.reasoning_content }
          }
          if (typeof delta.content === 'string' && delta.content) {
            if (!textOpen) { textOpen = true; yield { type: 'block-start', index: 1, blockType: 'text' } }
            text += delta.content; yield { type: 'text-delta', index: 1, text: delta.content }
          }
          for (const call of delta.tool_calls ?? []) {
            const idx = Number(call.index ?? 0); const blockIndex = idx + 2
            let current = tools.get(idx)
            if (!current) { current = { id: call.id ?? `call-${idx}`, name: '', arguments: '', index: blockIndex }; tools.set(idx, current); yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' } }
            if (call.id) current.id = call.id
            if (call.function?.name) current.name += call.function.name
            const args = call.function?.arguments ?? ''; current.arguments += args
            yield { type: 'tool-call-delta', index: blockIndex, id: CallId(current.id), ...(call.function?.name ? { name: current.name } : {}), argumentsDelta: args }
          }
        }
      }
    } catch (error) { throw failure(error) }
    if (reasoningOpen) yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } }
    if (textOpen) yield { type: 'block-end', index: 1, block: { type: 'text', text } }
    for (const tool of tools.values()) yield { type: 'block-end', index: tool.index, block: { type: 'tool-call', id: CallId(tool.id), name: tool.name, arguments: tool.arguments } }
    yield { type: 'finish', reason: { kind: tools.size || finish === 'tool_calls' ? 'tool-calls' : finish === 'length' ? 'max-tokens' : 'stop' } }
  }
  private requestOptions(signal?: AbortSignal): { route?: InferenceRoute; requiredLabels?: RequiredLabels; signal?: AbortSignal; serviceHeaders?: Record<string, string> } {
    return { ...(this.config.route ? { route: this.config.route } : {}), ...((this.config.requiredLabelsAnyOf?.length || this.config.requiredLabels?.length) ? { requiredLabels: (this.config.requiredLabelsAnyOf?.length ? this.config.requiredLabelsAnyOf : this.config.requiredLabels) as RequiredLabels } : {}), ...(signal ? { signal } : {}) }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const socketPath = typeof config.socketPath === 'string' && config.socketPath.startsWith('~/') ? `${homedir()}/${config.socketPath.slice(2)}` : config.socketPath
  const core = new SamClient({
    ...(socketPath !== undefined ? { socketPath } : {}),
    ...(config.tcpUrl !== undefined ? { tcpUrl: config.tcpUrl } : {}),
    ...(config.preferSocket !== undefined ? { preferSocket: config.preferSocket } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.nodeCredentialRef !== undefined ? { resolveNodeToken: async () => (await ctx.credentials.resolve(credentialRef(config.nodeCredentialRef!)))?.value } : {}),
  })
  const ref = config.capabilityCredentialRef
  const resolveCapability = ref ? async () => (await ctx.credentials.resolve(credentialRef(ref)))?.value : undefined
  ctx.llm.registerAdapter([PROVIDER], new SamLlmAdapter(new SamInferenceClient(core), config, resolveCapability))
}
