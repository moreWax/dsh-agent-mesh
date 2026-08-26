/**
 * The `agent-mesh` settings namespace: every plugin knob editable from
 * Settings → Plugins in the dsh Web UI. The Cordis row config (cordis.patch.yml)
 * feeds the composition `base` layer; user edits persist to
 * `$DSH_HOME/settings.yaml` through the settings service and layer on top.
 * Boot-time keys (connection, auto-node) take effect on the next dsh start —
 * declared honestly as `applies: 'restart'`; keys read at decision time
 * (stopNodeOnExit at dispose, nodeControlPlane at enrollment) apply live.
 */
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type { AgentMeshConfig } from './operator/index.js'

/** Settings namespace (kebab-case). The Web UI card is keyed by the same value. */
export const AGENT_MESH_NS: SettingsNamespace = settingsNamespace('agent-mesh')

export interface AgentMeshSettings {
  autoStartNode: boolean
  autoBeginEnrollment: boolean
  stopNodeOnExit: boolean
  /** '' means the manager default (https://hub.sam-mesh.dev). */
  nodeControlPlane: string
  /**
   * sam-node binary selection: '' = auto (the manager's suggestion — the
   * bundled binary when present, else PATH). Any other value is an explicit
   * absolute path from the card's dropdown (binaryOptions enumeration).
   */
  nodeBinary: string
  /** Managed-store REFERENCE for the pre-shared enrollment token; '' = interactive device flow. */
  nodeEnrollmentCredentialRef: string
  tcpUrl: string
  timeoutMs: number
  preferSocket: boolean
  socketPath: string | false
}

export const AgentMeshSettingsSchema = z.object({
  autoStartNode: z.boolean().default(true),
  autoBeginEnrollment: z.boolean().default(true),
  stopNodeOnExit: z.boolean().default(true),
  nodeControlPlane: z.string().default(''),
  nodeBinary: z.string().default(''),
  tcpUrl: z.string().default('http://127.0.0.1:8080'),
  timeoutMs: z.natural().default(30_000),
  preferSocket: z.boolean().default(true),
  socketPath: z.union([z.string(), z.const(false)]).default('~/.config/sam-mesh/sam.sock'),
}) as unknown as z<AgentMeshSettings>

/** Row config (cordis.patch.yml) becomes the composition base the user layer overrides. */
export function settingsBaseFromConfig(config: AgentMeshConfig): AgentMeshSettings {
  return {
    autoStartNode: config.autoStartNode ?? true,
    autoBeginEnrollment: config.autoBeginEnrollment ?? true,
    stopNodeOnExit: config.stopNodeOnExit ?? true,
    nodeControlPlane: config.nodeControlPlane ?? '',
    nodeBinary: config.nodeBinary ?? '',
    nodeEnrollmentCredentialRef: config.nodeEnrollmentCredentialRef ?? '',
    tcpUrl: config.tcpUrl,
    timeoutMs: config.timeoutMs,
    preferSocket: config.preferSocket,
    socketPath: config.socketPath,
  }
}

/** Subset of the settings the node lifecycle reads at decision time. */
export interface NodeDecisionConfig {
  autoStartNode: boolean
  autoBeginEnrollment: boolean
  stopNodeOnExit: boolean
  nodeControlPlane: string
}

export function nodeDecisionsOf(settings: AgentMeshSettings): NodeDecisionConfig {
  const { autoStartNode, autoBeginEnrollment, stopNodeOnExit, nodeControlPlane } = settings
  return { autoStartNode, autoBeginEnrollment, stopNodeOnExit, nodeControlPlane }
}
