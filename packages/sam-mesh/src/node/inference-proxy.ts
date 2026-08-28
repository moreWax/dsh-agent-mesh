/**
 * Loopback gate proxy for serving inference on the mesh.
 *
 * Doctrine: model LISTING is the phone book (open), EXECUTION is gated.
 * The proxy sits between the sam node's announced inference service and the
 * real OpenAI-compatible backend: GET /v1/models passes through, everything
 * else requires the fleet capability in the x-fleet-capability header
 * (timing-safe compare, uniform 403). The capability header and any inbound
 * Authorization are stripped; the upstream credential is injected instead.
 * Binds loopback only — the only inbound path is the mesh itself.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { FailureLimiter } from '../core/failure-limiter.js'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type GateClass = 'open' | 'gated'

/** Only model listing is open; every other path (chat, completions, embeddings, ...) is gated. */
export function classifyGate(method: string, pathname: string): GateClass {
  return method.toUpperCase() === 'GET' && pathname.replace(/\/$/, '') === '/v1/models' ? 'open' : 'gated'
}

/** Extract the token from an `Authorization: Bearer <token>` header (OpenAI-client alias for the gate). */
export function bearerOf(header: string | undefined): string | undefined {
  if (!header) return undefined
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim())
  return match?.[1]
}

/** Timing-safe capability comparison via digests (avoids length-oracle early exit). */
export function capabilityMatches(provided: string | undefined, required: string): boolean {
  if (!provided || !required) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(required).digest()
  return timingSafeEqual(a, b)
}

/** Identify a presented credential against the token set: member name + scopes, or undefined. */
export function identifyToken(provided: string | undefined, tokens: readonly GateToken[]): { member: string; scopes: string[] } | undefined {
  if (!provided) return undefined
  for (const candidate of tokens) {
    if (capabilityMatches(provided, candidate.token)) {
      return { member: candidate.member ?? 'member', scopes: candidate.scopes ?? [] }
    }
  }
  return undefined
}

/** Inference scope check: absent scopes = legacy full access (backward compatible). */
export function tokenMayExecute(identity: { scopes: string[] } | undefined): boolean {
  if (!identity) return false
  return identity.scopes.length === 0 || identity.scopes.includes('inference')
}

/** One accepted fleet credential at the gate: a member capability (with scopes) or the operator secret. */
export interface GateToken {
  token: string
  member?: string
  /** Absent scopes = legacy full access. */
  scopes?: string[]
}

export interface InferenceProxyOptions {
  host: string
  port: number
  /** Real OpenAI-compatible backend, e.g. http://127.0.0.1:4001 */
  target: string
  /** Bearer token injected as Authorization on every upstream request. */
  upstreamAuth?: string
  /** Fleet capability required on gated paths: a static value or a getter read PER REQUEST
   *  (rotation-safe). Empty string disables the gate (requires explicit opt-in at the CLI). */
  requiredCapability: string | (() => string)
  /** Per-member credentials (supersedes requiredCapability when present): every accepted
   *  token, read PER REQUEST so revocation is registry-deletion. Read PER REQUEST. */
  gateTokens?: () => readonly GateToken[] | Promise<readonly GateToken[]>
  /** Curate which backend models the mesh may see and run. Empty/absent = everything.
   *  Filtered from /v1/models AND enforced on execution (uniform 404). */
  modelAllowlist?: string[] | (() => string[])
  /** Cap on the request body the gate will buffer (allowlist filtering needs the whole
   *  body). A capability holder OOMing the gate is still an attacker; exceeded = 413. */
  maxBodyBytes?: number
  /** Denial throttling: past `denyPerWindow` denials per token per window the gate answers
   *  403 immediately and logs sparsely. A leaked/wrong token is a flood source. */
  denyPerWindow?: number
  onLog?: (line: string) => void
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host'])

function allowlistOf(options: InferenceProxyOptions): string[] | undefined {
  const list = typeof options.modelAllowlist === 'function' ? options.modelAllowlist() : options.modelAllowlist
  return list && list.length > 0 ? list : undefined
}

/** Model named by a chat/completions request body; undefined when unreadable. */
export function requestModel(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const model = (body as { model?: unknown }).model
  return typeof model === 'string' && model !== '' ? model : undefined
}

/** Listing payload with disallowed models removed; undefined when the body is not a model list. */
export function filterModelList(body: unknown, allowlist: string[]): unknown {
  if (typeof body !== 'object' || body === null || !Array.isArray((body as { data?: unknown }).data)) return undefined
  const data = (body as { data: Array<{ id?: unknown }> }).data.filter(m => typeof m.id === 'string' && allowlist.includes(m.id))
  return { ...(body as Record<string, unknown>), data }
}

/** sam's node sets X-Peer-Id when proxying inference — mesh peer attribution for the log. */
function peerOf(req: IncomingMessage): string {
  const peer = req.headers['x-peer-id']
  return typeof peer === 'string' && peer ? ` peer=${peer}` : ''
}

function safeJson(body: Buffer): unknown {
  try { return JSON.parse(body.toString('utf8')) } catch { return undefined }
}

export function createInferenceProxyServer(options: InferenceProxyOptions): Server {
  const target = new URL(options.target)
  const log = options.onLog ?? (() => {})
  const denyLimiter = new FailureLimiter({ perWindow: options.denyPerWindow ?? 20 })
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://loopback')
    const gate = classifyGate(req.method ?? 'GET', url.pathname)
    const required = typeof options.requiredCapability === 'function' ? options.requiredCapability() : options.requiredCapability
    // The dedicated header wins; `Authorization: Bearer <capability>` is the
    // same secret through the standard OpenAI-client credential slot, so any
    // off-the-shelf client (curl, pi-ai custom providers, aichat) can use the
    // fleet without a custom-header feature. Identical timing-safe compare.
    const allowlist = allowlistOf(options)
    const filterListing = allowlist !== undefined && gate === 'open'
    const enforceExecution = allowlist !== undefined && gate === 'gated' && (req.method ?? '').toUpperCase() === 'POST'
    void (async (): Promise<void> => {
      // The dedicated header wins; `Authorization: Bearer <capability>` is the
      // same secret through the standard OpenAI credential slot, so any
      // off-the-shelf client (curl, pi-ai custom providers, aichat) can use the
      // fleet without a custom-header feature. Identical timing-safe compare.
      const presented = (req.headers['x-fleet-capability'] as string | undefined) ?? bearerOf(req.headers.authorization)
      // Per-member credentials: identify against the token set first (scopes
      // apply); the single-secret path stays as the operator/legacy fallback.
      // Tokens are read PER REQUEST — revocation is registry deletion.
      const tokens = (await options.gateTokens?.()) ?? []
      const identity = tokens.length > 0 ? identifyToken(presented, tokens) : undefined
      const legacyOk = capabilityMatches(presented, required)
      if (gate === 'gated' && !(legacyOk || tokenMayExecute(identity))) {
        // Flood control: a wrong/leaked token can be denied forever but must
        // not be floodable forever. Past the window limit the gate answers
        // immediately (this path is already upstream-free) and logs sparsely.
        const verdict = denyLimiter.deny(FailureLimiter.keyOf(presented))
        if (verdict.log) log(`DENY ${req.method} ${url.pathname} ${identity ? `member=${identity.member} (scope)` : 'no valid capability'}${peerOf(req)}${verdict.throttled ? ' (throttled — further denials suppressed)' : ''}`)
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fleet capability required', type: 'capability_required' } }))
        return
      }
      let body: Buffer | undefined
      if (filterListing || enforceExecution) {
        const max = options.maxBodyBytes ?? 10 * 1024 * 1024
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of req) {
          size += (chunk as Buffer).length
          // A capability holder OOMing the gate is still an attacker: bound
          // the buffered body and refuse beyond it (413, connection dropped).
          if (size > max) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'request body too large', type: 'body_too_large' } }))
            req.destroy()
            return
          }
          chunks.push(chunk as Buffer)
        }
        body = Buffer.concat(chunks)
        if (enforceExecution && body.length > 0) {
          let parsed: unknown
          try { parsed = JSON.parse(body.toString('utf8')) } catch { parsed = undefined }
          const model = requestModel(parsed)
          if (model !== undefined && !allowlist.includes(model)) {
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: { message: 'model not available through this gate', type: 'model_not_available' } }))
            return
          }
        }
      }
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase()
        if (HOP_BY_HOP.has(lower) || lower === 'x-fleet-capability' || lower === 'authorization') continue
        if (body !== undefined && lower === 'content-length') continue
        if (typeof value === 'string') headers[lower] = value
      }
      if (options.upstreamAuth) headers['authorization'] = `Bearer ${options.upstreamAuth}`
      if (body !== undefined) headers['content-length'] = String(body.length)
      if (gate === 'gated') {
        const who = identity ? `member=${identity.member}` : legacyOk ? 'operator' : 'ungated'
        const model = body !== undefined ? requestModel(safeJson(body)) : undefined
        log(`EXEC ${req.method} ${url.pathname}${model ? ` model=${model}` : ''} ${who}${peerOf(req)}`)
      }
      const upstream = httpRequest({
        hostname: target.hostname,
        port: target.port,
        method: req.method,
        path: url.pathname + url.search,
        headers,
      }, (upstreamRes) => {
        if (filterListing && (upstreamRes.statusCode ?? 500) === 200) {
          const chunks: Buffer[] = []
          upstreamRes.on('data', (c: Buffer) => chunks.push(c))
          upstreamRes.on('end', () => {
            let parsed: unknown
            try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { parsed = undefined }
            const filtered = parsed === undefined ? undefined : filterModelList(parsed, allowlist)
            const out = filtered === undefined ? Buffer.concat(chunks) : Buffer.from(JSON.stringify(filtered))
            const outHeaders = { ...(upstreamRes.headers as Record<string, string>) }
            delete outHeaders['content-length']; delete outHeaders['content-encoding']; delete outHeaders['transfer-encoding']
            res.writeHead(200, { ...outHeaders, 'content-type': 'application/json', 'content-length': String(out.length) })
            res.end(out)
          })
          return
        }
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers as Record<string, string>)
        upstreamRes.pipe(res)
      })
      upstream.on('error', (error) => {
        log(`upstream error: ${error.message}`)
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'inference backend unreachable', type: 'backend_unreachable' } }))
      })
      if (body !== undefined) upstream.end(body)
      else req.pipe(upstream)
    })().catch((error: unknown) => {
      log(`proxy error: ${error instanceof Error ? error.message : String(error)}`)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'gate proxy error', type: 'proxy_error' } }))
    })
  })
}

export interface AnnounceOptions {
  /** Sends the register body to the local node; must throw on non-2xx.
   *  (Use requestRaw: /sam/service/register answers a non-JSON body.) */
  register: (body: unknown) => Promise<void>
  name: string
  targetUrl: string
  intervalMs?: number
  onLog?: (line: string) => void
}

/**
 * Keeps the inference service announced on the local node. Registrations live
 * in node memory only, so the loop re-announces: node restarts self-heal.
 * Returns a stop function.
 */
export function startAnnounceLoop(options: AnnounceOptions): () => void {
  const intervalMs = options.intervalMs ?? 30_000
  const log = options.onLog ?? (() => {})
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  const body = { service: { name: options.name, type: 'SERVICE_TYPE_INFERENCE', description: 'capability-gated mesh inference (listing open, execution gated)' }, target_url: options.targetUrl }
  const tick = async (): Promise<void> => {
    try {
      await options.register(body)
      log(`announced inference service ${options.name} -> ${options.targetUrl}`)
    } catch (error) {
      log(`announce failed (retrying): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}

export interface BackendCandidate { name: string; url: string }

/** Well-known loopback OpenAI-compatible backends, in priority order. */
export const WELL_KNOWN_BACKENDS: BackendCandidate[] = [
  { name: 'ollama', url: 'http://127.0.0.1:11434' },
  { name: 'lm-studio', url: 'http://127.0.0.1:1234' },
  { name: 'llama.cpp', url: 'http://127.0.0.1:8080' },
  { name: 'vllm', url: 'http://127.0.0.1:8000' },
  { name: 'litellm', url: 'http://127.0.0.1:4000' },
  { name: 'litellm', url: 'http://127.0.0.1:4001' },
]

type ProbeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number }>

/** A backend is PRESENT when /v1/models answers at all — 200 (open) or 401/403
 *  (auth-required; the row's upstreamAuthCredentialRef covers it). Anything
 *  else (connection refused, 404, 5xx) counts as absent. */
export async function probeBackend(candidate: BackendCandidate, fetchImpl: ProbeFetch = fetch as unknown as ProbeFetch, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetchImpl(`${candidate.url}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status === 200 || res.status === 401 || res.status === 403
  } catch { return false }
}

export interface AutoTargetResolution { target: string; found: BackendCandidate[]; ambiguous: boolean }

/** Deterministic: the highest-priority present backend wins; `found` + `ambiguous`
 *  let the caller log loudly when there was more than one choice. */
export function resolveAutoTarget(present: BackendCandidate[]): AutoTargetResolution {
  if (present.length === 0) throw new Error(`target auto found no OpenAI-compatible backend (probed: ${WELL_KNOWN_BACKENDS.map(b => `${b.name} ${b.url}`).join(', ')}). Start one, or set an explicit target.`)
  return { target: present[0]!.url, found: present, ambiguous: present.length > 1 }
}

export async function detectInferenceBackends(candidates: BackendCandidate[] = WELL_KNOWN_BACKENDS, fetchImpl?: ProbeFetch): Promise<AutoTargetResolution> {
  const present = (await Promise.all(candidates.map(async c => await probeBackend(c, fetchImpl) ? c : undefined))).filter((c): c is BackendCandidate => c !== undefined)
  return resolveAutoTarget(present)
}
