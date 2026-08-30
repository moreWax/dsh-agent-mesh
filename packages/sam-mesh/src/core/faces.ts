/**
 * Structural service faces for cross-plugin consumption. dsh plugins consume
 * the agent-mesh plugin's services through cordis injection — never imports —
 * and these are the compiler-checked shapes of that seam (previously anonymous
 * `ctx as unknown as {...}` casts at every call site).
 */
import type { SamClient } from './client.js'
import type { SamRegistrationTransport } from './registration.js'

/** The mesh-core surface a plugin needs (a narrow Pick of SamClient). */
export type MeshCoreFace = Pick<SamClient, 'callRemoteTool' | 'discoverRemoteServices' | 'listLocalServices' | 'getMeshInfo' | 'callTool'> & SamRegistrationTransport

/** The agentMesh service as consumed cross-plugin: the core plus the fleet capability resolver. */
export interface AgentMeshFace {
  core: MeshCoreFace
  resolveCallCapability?: () => Promise<string | undefined>
}

/** The task-service surface for tool mounting (registry injection). */
export interface TaskServiceToolMount {
  tools: { register(tool: unknown): unknown; get?(name: string): unknown }
}

/** The chat poster the task service's audit bridge consumes (provided by dsh-mesh-chat). */
export interface MeshChatPoster {
  postSystem?(text: string, meta?: unknown): void
}
