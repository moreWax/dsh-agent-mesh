/** Cordis plugin entry for the opt-in SAM -> ctx.tools provider. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentMeshService } from '../index.js'
import { SamToolsProvider, type ToolsProviderConfig } from './tools.js'

export const name = 'agent-mesh-tools'
export const inject = ['agentMesh', 'tools']
export type Config = ToolsProviderConfig
export const Config: z<Config> = z.object({
  intent: z.string(), peerId: z.string(), serviceName: z.string(), toolName: z.string(),
  requiredLabelsAnyOf: z.array(z.string()).default([]),
  refreshIntervalMs: z.number().default(60_000),
  failOnStartupError: z.boolean().default(false),
}) as unknown as z<Config>

export async function apply(ctx: Context, config: Config): Promise<void> {
  const provider = new SamToolsProvider(ctx as Context & { agentMesh: AgentMeshService; tools: any }, config)
  ctx.effect(() => () => provider.dispose(), 'agent-mesh-tools.provider')
  try { await provider.refresh() }
  catch (error) {
    if (config.failOnStartupError) throw error
    ctx.logger.warn(`agent-mesh-tools: initial refresh failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const interval = config.refreshIntervalMs ?? 60_000
  if (interval < 0 || !Number.isSafeInteger(interval)) throw new TypeError('agent-mesh-tools: refreshIntervalMs must be a non-negative safe integer')
  if (interval > 0) {
    const timer = setInterval(() => void provider.refresh().catch(error => {
      ctx.logger.warn(`agent-mesh-tools: refresh failed; retaining prior generation: ${error instanceof Error ? error.message : String(error)}`)
    }), interval)
    timer.unref()
    ctx.effect(() => () => clearInterval(timer), 'agent-mesh-tools.refresh')
  }
}
