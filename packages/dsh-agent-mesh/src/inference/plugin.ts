/** Opt-in row: serve an OpenAI-compatible backend on the mesh, capability-gated. */
import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials/types'
import { createInferenceProxyServer, startAnnounceLoop } from '@morewax/sam-mesh/node'
import type { AgentMeshService } from '../index.js'

export const name = 'agent-mesh-inference'
export const inject = ['agentMesh', 'credentials']

export interface RuntimeConfig {
  /** What to serve: 'org/repo', 'org/repo:quant', 'org/repo/file.gguf', or a GGUF path. Must already be in the store (pull via card/CLI — boot never downloads). */
  model?: string
  /** Stable model id the mesh sees (default: derived from the spec). */
  alias?: string
  port?: number
  contextSize?: number
  gpuLayers?: number
}
export interface Config {
  /** The real OpenAI-compatible backend, e.g. http://127.0.0.1:4001 (REQUIRED — serving is explicit). */
  target?: string
  /** Built-in vendored llama.cpp runtime: serve a GGUF with NOTHING installed. Mutually exclusive with target. */
  runtime?: RuntimeConfig
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
  runtime: z.object({
    model: z.string(),
    alias: z.string(),
    port: z.number().min(1).max(65535).default(8180),
    contextSize: z.number().min(256).default(4096),
    gpuLayers: z.number().min(0).default(99),
  }),
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
  // schemastery materializes an all-defaulted object even when absent — runtime only counts when model is set.
  const runtimeCfg = config.runtime?.model ? config.runtime : undefined
  if (config.target && runtimeCfg) throw new Error('agent-mesh-inference: target and runtime are mutually exclusive — the vendored runtime IS the backend')
  if (!config.target && !runtimeCfg) throw new Error("agent-mesh-inference requires config.target (backend URL or 'auto') or config.runtime (vendored llama.cpp) — serving is always explicit")
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
  let runtime: import('@morewax/sam-mesh/node').LlamaRuntime | undefined
  if (runtimeCfg) {
    const rc = runtimeCfg as RuntimeConfig & { model: string }
    const { resolveVendoredLlama, parseModelSpec, modelStorePath, resolveHfFile, LlamaRuntime } = await import('@morewax/sam-mesh/node')
    const dataDir = join(homedir(), '.config', 'sam-mesh')
    const spec = parseModelSpec(rc.model)
    let modelPath: string
    let defaultAlias: string
    if (spec.kind === 'path') {
      const p = rc.model.startsWith('~/') ? join(homedir(), rc.model.slice(2)) : rc.model
      if (!existsSync(p)) throw new Error(`runtime model not found at ${p}`)
      modelPath = p
      defaultAlias = p.split('/').pop()!.replace(/\.gguf$/i, '')
    } else {
      const resolved = await resolveHfFile(spec)
      modelPath = modelStorePath(dataDir, spec.repo, resolved.file)
      if (!existsSync(modelPath)) throw new Error(`model ${rc.model} is not in the local store — pull it first (card → Share models, or: sam-mesh runtime pull '${rc.model}'). Boot-time code never downloads.`)
      defaultAlias = resolved.file.replace(/\.gguf$/i, '')
    }
    const alias = rc.alias ?? defaultAlias
    const vendored = await resolveVendoredLlama(dataDir)
    runtime = new LlamaRuntime(vendored, {
      modelPath, alias,
      port: rc.port ?? 8180,
      ...(rc.contextSize !== undefined ? { contextSize: rc.contextSize } : {}),
      ...(rc.gpuLayers !== undefined ? { gpuLayers: rc.gpuLayers } : {}),
      onLog: (line) => console.info(`[agent-mesh-inference:runtime] ${line}`),
    })
    await runtime.start()
    target = `http://127.0.0.1:${rc.port ?? 8180}`
    log(`vendored llama.cpp ${vendored.tag} serving ${alias} on :${rc.port ?? 8180}`)
  }
  if (target === 'auto') {
    const { detectInferenceBackends } = await import('@morewax/sam-mesh/node')
    const auto = await detectInferenceBackends()
    target = auto.target
    log(`auto-detected backend: ${auto.found[0]!.name} at ${auto.target}${auto.ambiguous ? ` (also found: ${auto.found.slice(1).map(b => `${b.name} ${b.url}`).join(', ')} — set target explicitly to pin)` : ''}`)
  }
  if (!target) throw new Error('agent-mesh-inference: no backend resolved (unreachable — config validated target or runtime)')
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
    if (runtime) void runtime.stop()
  })
}
