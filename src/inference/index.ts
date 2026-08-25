/** OpenAI-compatible inference over a SAM node's HTTP abstraction. */

export interface SamHttpRequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  serviceHeaders?: Record<string, string>
  signal?: AbortSignal
}

/** Minimal core-client contract. Keeping this structural avoids an LLM seam dependency. */
export interface SamInferenceTransport {
  request<T>(path: string, options?: SamHttpRequestOptions): Promise<T>
  requestStream?(path: string, options?: SamHttpRequestOptions): AsyncIterable<Uint8Array | string>
}

export interface Model {
  id: string
  object?: string
  created?: number
  owned_by?: string
  [key: string]: unknown
}
export interface ModelList { object: string; data: Model[] }

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool' | 'function'
export interface ChatMessage {
  role: ChatRole
  content: string | null | Array<Record<string, unknown>>
  name?: string
  tool_call_id?: string
  [key: string]: unknown
}
export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  [key: string]: unknown
}
export interface ChatCompletionChoice {
  index: number
  message: ChatMessage
  finish_reason: string | null
  [key: string]: unknown
}
export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: Record<string, number>
  [key: string]: unknown
}
export interface ChatCompletionChunk {
  id: string
  object: string
  created: number
  model: string
  choices: Array<Record<string, unknown>>
  [key: string]: unknown
}

export type RequiredLabels = string | readonly string[] | Readonly<Record<string, string>>
export type InferenceRoute =
  | { mode?: 'auto' }
  | { mode: 'pinned'; localProxyUrl: string }

export interface InferenceRequestOptions {
  route?: InferenceRoute
  /** Comma-separated any-of constraints, sent as X-Sam-Required-Labels. */
  requiredLabels?: RequiredLabels
  signal?: AbortSignal
}

export class InferenceError extends Error {
  readonly code: string
  readonly cause?: unknown
  constructor(message: string, code = 'SAM_INFERENCE_ERROR', cause?: unknown) {
    super(message)
    this.name = 'InferenceError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}
export class InferenceProtocolError extends InferenceError {
  constructor(message: string, cause?: unknown) {
    super(message, 'SAM_INFERENCE_PROTOCOL_ERROR', cause)
    this.name = 'InferenceProtocolError'
  }
}
export class InferenceStreamingUnsupportedError extends InferenceError {
  constructor() {
    super('The configured SAM HTTP transport does not support streaming', 'SAM_INFERENCE_STREAMING_UNSUPPORTED')
    this.name = 'InferenceStreamingUnsupportedError'
  }
}

function labelsHeader(labels: RequiredLabels | undefined): string | undefined {
  if (labels === undefined) return undefined
  const values = typeof labels === 'string'
    ? labels.split(',').map((item) => item.trim()).filter(Boolean)
    : Array.isArray(labels)
      ? labels.map((item) => item.trim()).filter(Boolean)
      : Object.entries(labels as Readonly<Record<string, string>>).map(([key, value]) => `${key}=${value}`)
  if (values.length === 0) throw new InferenceProtocolError('requiredLabels must not be empty')
  for (const value of values) {
    if (!/^[^=,\s]+=[^,\s]+$/.test(value)) {
      throw new InferenceProtocolError(`Invalid required label ${JSON.stringify(value)}; expected key=value`)
    }
  }
  return values.join(',')
}

function routePath(route: InferenceRoute | undefined, suffix: string): string {
  if (!route || route.mode !== 'pinned') return `/v1/${suffix}`
  if (!route.localProxyUrl) throw new InferenceProtocolError('Pinned route requires localProxyUrl')
  let url: URL
  try { url = new URL(route.localProxyUrl) } catch (cause) {
    throw new InferenceProtocolError('Pinned localProxyUrl must be an absolute URL', cause)
  }
  // local_proxy_url is a route through this same SAM node. Deliberately retain
  // only path/query so socket-first transport and its authentication stay in force.
  const base = url.pathname.replace(/\/+$/, '')
  const versionedSuffix = suffix.startsWith('v1/') ? suffix : `v1/${suffix}`
  return `${base}/${versionedSuffix}${url.search}`
}

function requestOptions(body: unknown, options: InferenceRequestOptions): SamHttpRequestOptions {
  const label = labelsHeader(options.requiredLabels)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (label) headers['X-Sam-Required-Labels'] = label
  const out: SamHttpRequestOptions = { method: 'POST', body, headers }
  if (options.signal) out.signal = options.signal
  return out
}

/** High-level SAM OpenAI facade client. It never retries; routing/failover belongs to SAM/core. */
export class SamInferenceClient {
  constructor(private readonly transport: SamInferenceTransport) {}

  async models(options: InferenceRequestOptions = {}): Promise<ModelList> {
    const path = routePath(options.route, 'models')
    const headers: Record<string, string> = {}
    const label = labelsHeader(options.requiredLabels)
    if (label) headers['X-Sam-Required-Labels'] = label
    const request: SamHttpRequestOptions = { method: 'GET', headers }
    if (options.signal) request.signal = options.signal
    try {
      const result = await this.transport.request<ModelList>(path, request)
      if (!result || !Array.isArray(result.data)) throw new InferenceProtocolError('Invalid OpenAI model list response')
      return result
    } catch (cause) {
      if (cause instanceof InferenceError) throw cause
      throw new InferenceError('SAM model listing failed', 'SAM_MODELS_FAILED', cause)
    }
  }

  listModels(options: InferenceRequestOptions = {}): Promise<ModelList> { return this.models(options) }

  async chat(request: ChatCompletionRequest & { stream?: false }, options?: InferenceRequestOptions): Promise<ChatCompletionResponse>
  async chat(request: ChatCompletionRequest & { stream: true }, options?: InferenceRequestOptions): Promise<AsyncIterable<ChatCompletionChunk>>
  async chat(request: ChatCompletionRequest, options: InferenceRequestOptions = {}): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    if (!request.model || !Array.isArray(request.messages)) throw new InferenceProtocolError('Chat request requires model and messages')
    const path = routePath(options.route, 'chat/completions')
    const coreOptions = requestOptions(request, options)
    if (request.stream === true) {
      if (!this.transport.requestStream) throw new InferenceStreamingUnsupportedError()
      let bytes: AsyncIterable<Uint8Array | string>
      try { bytes = this.transport.requestStream(path, coreOptions) }
      catch (cause) { throw new InferenceError('SAM chat stream failed', 'SAM_CHAT_STREAM_FAILED', cause) }
      return parseSse(bytes)
    }
    try {
      const response = await this.transport.request<ChatCompletionResponse>(path, coreOptions)
      if (!response || !Array.isArray(response.choices)) throw new InferenceProtocolError('Invalid OpenAI chat completion response')
      return response
    } catch (cause) {
      if (cause instanceof InferenceError) throw cause
      throw new InferenceError('SAM chat completion failed', 'SAM_CHAT_FAILED', cause)
    }
  }

  chatCompletions(request: ChatCompletionRequest & { stream?: false }, options?: InferenceRequestOptions): Promise<ChatCompletionResponse>
  chatCompletions(request: ChatCompletionRequest & { stream: true }, options?: InferenceRequestOptions): Promise<AsyncIterable<ChatCompletionChunk>>
  chatCompletions(request: ChatCompletionRequest, options?: InferenceRequestOptions): Promise<ChatCompletionResponse | AsyncIterable<ChatCompletionChunk>> {
    if (request.stream === true) return this.chat(request as ChatCompletionRequest & { stream: true }, options)
    return this.chat(request as ChatCompletionRequest & { stream?: false }, options)
  }
}

export { SamInferenceClient as InferenceClient }

async function* parseSse(source: AsyncIterable<Uint8Array | string>): AsyncIterable<ChatCompletionChunk> {
  const decoder = new TextDecoder()
  let buffer = ''
  const consume = function* (block: string): Generator<ChatCompletionChunk> {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return
    try { yield JSON.parse(data) as ChatCompletionChunk }
    catch (cause) { throw new InferenceProtocolError('Invalid JSON in OpenAI SSE stream', cause) }
  }
  try {
    for await (const chunk of source) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let match: RegExpExecArray | null
      while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const block = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        yield* consume(block)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) yield* consume(buffer)
  } catch (cause) {
    if (cause instanceof InferenceError) throw cause
    throw new InferenceError('SAM chat stream failed', 'SAM_CHAT_STREAM_FAILED', cause)
  }
}
