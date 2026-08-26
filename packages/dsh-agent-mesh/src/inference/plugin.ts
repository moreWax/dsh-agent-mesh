/** Opt-in row: serve an OpenAI-compatible backend on the mesh, capability-gated. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials/types'
import { createInferenceProxyServer, startAnnounceLoop } from '@morewax/sam-mesh/node'
import type { AgentMeshService } from '../index.js'

export const name = 'agent-mesh-inference'
export const inject = ['agentMesh', 'credentials']

export interface Config {
  /** The real OpenAI-compatible backend, e.g. http://127.0.0.1:4001 (REQUIRED — serving is explicit). */
  target?: string
  host?: string
  port?: number
  /** Bearer credential (managed store) injected upstream; never crosses the mesh. */
  upstreamAuthCredentialRef?: string
  /** Gate credential ref. Empty = fall back to the agent-mesh row's callCapabilityRef. */
  capabilityCredentialRef?: string
  /** Explicitly serve UNGATED (public phone book AND public execution). Off = refuse to start without a capability. */
  allowUngated?: boolean
  /** Mesh-wide service name to announce; empty disables announcement. */
  announceName?: string
  announceIntervalMs?: number
  /** How often the gate capability is re-resolved (rotation window). */
  capabilityRefreshMs?: number
  /** Curate which backend models the mesh may see and run. Empty = everything the backend advertises. */
  modelAllowlist?: string[]
}
export const Config: z<Config> = z.object({
  target: z.string(),
  host: z.string().default('127.0.0.1'),
  port: z.number().min(1).max(65535).default(4100),
  upstreamAuthCredentialRef: z.string().default(''),
  capabilityCredentialRef: z.string().default(''),
  allowUngated: z.boolean().default(false),
  announceName: z.string().default('dsh-mesh-inference'),
  announceIntervalMs: z.number().min(1000).default(30_000),
  capabilityRefreshMs: z.number().min(1000).default(60_000),
  modelAllowlist: z.array(z.string()).default([]),
}) as unknown as z<Config>

type ServeContext = Context & { agentMesh: AgentMeshService }

export async function apply(ctx: ServeContext, config: Config = {}): Promise<void> {
  if (!config.target) throw new Error("agent-mesh-inference requires config.target (the OpenAI-compatible backend to gate, or 'auto' to detect a local one) — serving is always explicit")
  const host = config.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error(`agent-mesh-inference refuses non-loopback bind (${host}): the mesh is the only inbound path`)
  const port = config.port ?? 4100

  const resolveUpstreamAuth = config.upstreamAuthCredentialRef
    ? async () => (await ctx.credentials.resolve(credentialRef(config.upstreamAuthCredentialRef!)).catch(() => undefined))?.value
    : undefined
  const ref = config.capabilityCredentialRef?.trim()
  const resolveCapability = ref
    ? async () => (await ctx.credentials.resolve(credentialRef(ref)).catch(() => undefined))?.value
    : ctx.agentMesh.resolveCallCapability

  let capability = ''
  const refresh = async (): Promise<void> => { capability = (await resolveCapability?.()) ?? '' }
  await refresh()
  if (!capability && !config.allowUngated) {
    throw new Error('agent-mesh-inference found no gate capability (capabilityCredentialRef unset and agent-mesh callCapabilityRef unresolved) — refusing to serve UNGATED; set the ref or pass allowUngated: true explicitly')
  }
  const upstreamAuth = (await resolveUpstreamAuth?.()) ?? ''

  const log = (line: string): void => console.info(`[agent-mesh-inference] ${line}`)
  let target = config.target
  if (target === 'auto') {
    const { detectInferenceBackends } = await import('@morewax/sam-mesh/node')
    const auto = await detectInferenceBackends()
    target = auto.target
    log(`auto-detected backend: ${auto.found[0]!.name} at ${auto.target}${auto.ambiguous ? ` (also found: ${auto.found.slice(1).map(b => `${b.name} ${b.url}`).join(', ')} — set target explicitly to pin)` : ''}`)
  }
  // The gate compares against the CURRENT value; the refresh interval bounds
  // the rotation window. Empty capability => every gated path 403s (fail closed).
  const server = createInferenceProxyServer({
    host, port, target,
    ...(upstreamAuth ? { upstreamAuth } : {}),
    requiredCapability: () => capability,
    ...(config.modelAllowlist?.length ? { modelAllowlist: config.modelAllowlist } : {}),
    onLog: log,
  })
  const refreshTimer = setInterval(() => void refresh(), config.capabilityRefreshMs ?? 60_000)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()) })
  log(`gated proxy on http://${host}:${port} -> ${target} (${capability ? 'capability gate ON' : 'GATE OFF — allowed explicitly'})`)

  let stopAnnounce: (() => void) | undefined
  if (config.announceName) {
    const register = async (body: unknown): Promise<void> => {
      const res = await ctx.agentMesh.core.requestRaw('/sam/service/register', { method: 'POST', body })
      if (res.status < 200 || res.status >= 300) throw new Error(`register failed (${res.status})`)
    }
    stopAnnounce = startAnnounceLoop({ register, name: config.announceName, targetUrl: `http://${host}:${port}`, intervalMs: config.announceIntervalMs ?? 30_000, onLog: log })
  }

  ctx.effect(() => () => {
    if (stopAnnounce) stopAnnounce()
    clearInterval(refreshTimer)
    server.close()
  })
}
