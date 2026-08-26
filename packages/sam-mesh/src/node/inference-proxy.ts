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
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

export type GateClass = 'open' | 'gated'

/** Only model listing is open; every other path (chat, completions, embeddings, ...) is gated. */
export function classifyGate(method: string, pathname: string): GateClass {
  return method.toUpperCase() === 'GET' && pathname.replace(/\/$/, '') === '/v1/models' ? 'open' : 'gated'
}

/** Timing-safe capability comparison via digests (avoids length-oracle early exit). */
export function capabilityMatches(provided: string | undefined, required: string): boolean {
  if (!provided || !required) return false
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(required).digest()
  return timingSafeEqual(a, b)
}

export interface InferenceProxyOptions {
  host: string
  port: number
  /** Real OpenAI-compatible backend, e.g. http://127.0.0.1:4001 */
  target: string
  /** Bearer token injected as Authorization on every upstream request. */
  upstreamAuth?: string
  /** Fleet capability required on gated paths. Empty string disables the gate (requires explicit opt-in at the CLI). */
  requiredCapability: string
  onLog?: (line: string) => void
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'host'])

export function createInferenceProxyServer(options: InferenceProxyOptions): Server {
  const target = new URL(options.target)
  const log = options.onLog ?? (() => {})
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://loopback')
    const gate = classifyGate(req.method ?? 'GET', url.pathname)
    if (gate === 'gated' && !capabilityMatches(req.headers['x-fleet-capability'] as string | undefined, options.requiredCapability)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'fleet capability required', type: 'capability_required' } }))
      return
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower) || lower === 'x-fleet-capability' || lower === 'authorization') continue
      if (typeof value === 'string') headers[lower] = value
    }
    if (options.upstreamAuth) headers['authorization'] = `Bearer ${options.upstreamAuth}`
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: url.pathname + url.search,
      headers,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers as Record<string, string>)
      upstreamRes.pipe(res)
    })
    upstream.on('error', (error) => {
      log(`upstream error: ${error.message}`)
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'inference backend unreachable', type: 'backend_unreachable' } }))
    })
    req.pipe(upstream)
  })
}

export interface AnnounceOptions {
  /** POSTs to the local node, e.g. (path, opts) => sam.request(path, opts). */
  request: <T>(path: string, opts: { method: string; body?: unknown }) => Promise<T>
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
      await options.request('/sam/service/register', { method: 'POST', body })
      log(`announced inference service ${options.name} -> ${options.targetUrl}`)
    } catch (error) {
      log(`announce failed (retrying): ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs)
  }
  void tick()
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
