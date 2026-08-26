/** The deliberately small boundary between the operator facade and a mesh core. */
export interface SamCore {
  callTool<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T>
  request<T>(path: string, init?: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal; upstreamAuthorization?: string }): Promise<T>
}
/** Backwards-friendly name for the core dependency used by the operator. */
export type OperatorCore = SamCore

export type NodeState = "online" | "offline" | "starting" | "degraded" | "unknown"
export interface NodeStatus { state: NodeState; peerId?: string; version?: string; uptimeMs?: number; addresses?: readonly string[]; detail?: string }
export interface Readiness { ready: boolean; checks: Readonly<Record<string, boolean>>; reasons: readonly string[] }
export interface Diagnostic { name: string; ok: boolean; message?: string; data?: unknown }
export interface Diagnostics { healthy: boolean; checks: readonly Diagnostic[]; capturedAt: string }
export interface MeshService { id: string; name: string; protocol?: string; endpoint?: string; metadata?: Readonly<Record<string, unknown>> }
export interface ServiceRegistrationRequest { name: string; protocol: string; endpoint: string; metadata?: Readonly<Record<string, unknown>>; ttlSeconds?: number }
export interface LogQuery { limit?: number; since?: string; level?: "debug" | "info" | "warn" | "error" }
export interface LogEntry { timestamp: string; level: string; message: string; source?: string }
export interface TokenStatus { present: boolean; expiresAt?: string; scopes?: readonly string[]; source?: string }
export interface Connectivity { connected: boolean; peers: number; bootstrap?: boolean; latencyMs?: number; error?: string }

export type CliRisk = "read-only" | "mutating" | "destructive"
export interface CommandApproval { approved: true; approvedBy: string; approvedAt?: string; reason?: string }
export interface CliCommandPlan { executable: "sam-node"; args: readonly string[]; display: string; risk: CliRisk; requiresApproval: boolean; approved: boolean; warnings: readonly string[] }
export interface SkillInstallRequest { source: string; name?: string; version?: string; target?: string; force?: boolean }
export interface SkillInstallPlan { command: CliCommandPlan; request: Readonly<SkillInstallRequest> }


/** Parsed, transport-safe plugin configuration. */
export interface AgentMeshConfig { socketPath: string | false; tcpUrl: string; preferSocket: boolean; nodeCredentialRef?: string; /** Reference to the pre-shared enrollment token in ctx.credentials (bootstrap enrollment); unset = interactive device flow. */ nodeEnrollmentCredentialRef?: string; timeoutMs: number; autoStartNode?: boolean; autoBeginEnrollment?: boolean; nodeControlPlane?: string; stopNodeOnExit?: boolean; nodeAnnouncePrivate?: boolean; callCapabilityRef?: string }
export interface AgentMeshConfigInput { socketPath?: string | false; tcpUrl?: string; preferSocket?: boolean; /** Reference only; secret values belong in ctx.credentials. */ nodeCredentialRef?: string; /** Reference only; pre-shared enrollment token lives in ctx.credentials. */ nodeEnrollmentCredentialRef?: string; timeoutMs?: number; autoStartNode?: boolean; autoBeginEnrollment?: boolean; nodeControlPlane?: string; stopNodeOnExit?: boolean; /** Publish RFC1918/ULA addresses; false on the public hub. */ nodeAnnouncePrivate?: boolean; /** Credential ref for the outgoing-call fleet capability. */ callCapabilityRef?: string }

export interface ServiceRegistrationResponse { id?: string; service?: MeshService; [key: string]: unknown }
export interface SetupOptions { createConfig?: boolean; startNode?: boolean }
export interface SetupPlan { readonly commands: readonly CliCommandPlan[]; readonly readyToExecute: boolean; readonly warnings: readonly string[] }
export interface MeshCheckup { healthy: boolean; mesh: unknown; network?: unknown; token?: unknown; services?: readonly MeshService[]; failures: readonly Diagnostic[]; capturedAt: string }

/** Cordis-facing, read-only operational surface. */
export interface AgentMeshStatusService {
  status(signal?: AbortSignal): Promise<MeshCheckup>
  checkup(signal?: AbortSignal): Promise<MeshCheckup>
  setup(options?: SetupOptions): SetupPlan
}
