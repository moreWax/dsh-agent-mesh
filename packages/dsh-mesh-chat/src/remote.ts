import { z } from "zod"
import type { RemoteResult, TypertRemoteContribution } from "@deepseek-ai/dsh-typert-protocol"
import type { ActionResult, ChatSnapshot } from "./web/host.js"

declare module "@deepseek-ai/dsh-typert-protocol" { interface TypertRemoteNamespaceMap { agentMeshChatWeb: {
  chatSnapshot(afterId: number): Promise<RemoteResult<ChatSnapshot>>
  chatSend(text: string): Promise<RemoteResult<ActionResult>>
  dmSend(peerId: string, text: string): Promise<RemoteResult<ActionResult>>
} } }

const any = z.unknown()
const parameter = (name: string, schema: z.ZodType) => ({ name, wire: name, source: "json" as const, codec: { mode: "strict" as const, typeSymbol: `@morewax/dsh-mesh-chat#${name}`, schema } })
const result = (name: string, schema: z.ZodType) => ({ mode: "strict" as const, typeSymbol: `@morewax/dsh-mesh-chat#${name}`, schema })
const descriptor = (method: string, parameters: ReturnType<typeof parameter>[], schema: z.ZodType = any) => ({ id: `@morewax/dsh-mesh-chat#agentMeshChatWeb/${method}`, service: "agentMeshChatWeb", namespace: "agentMeshChatWeb", method, invocation: { kind: "direct" as const }, parameters, result: result(`${method}Result`, schema) })
const chatMessage = z.object({ id: z.number(), kind: z.union([z.literal("user"), z.literal("system")]), sender: z.string(), text: z.string(), ts: z.number(), meta: z.unknown().optional() })
const chatSnapshot = z.object({
  fleet: z.object({ available: z.boolean(), cursor: z.number(), messages: z.array(chatMessage), error: z.string().optional() }),
  inbox: z.object({ serviceName: z.string(), messages: z.array(chatMessage) }),
  peers: z.array(z.object({ peerId: z.string(), name: z.string() })),
  health: z.object({ hubConsistent: z.boolean(), rejectionCount: z.number(), ts: z.number(), stale: z.boolean() }).optional(),
})
const actionResult = z.union([z.object({ ok: z.literal(true), message: z.string().optional() }), z.object({ ok: z.literal(false), error: z.string() })])
export const TYPERT_REMOTE: TypertRemoteContribution = { package: "@morewax/dsh-mesh-chat", descriptors: [
  descriptor("chatSnapshot", [parameter("afterId", z.number())], chatSnapshot),
  descriptor("chatSend", [parameter("text", z.string())], actionResult),
  descriptor("dmSend", [parameter("peerId", z.string()), parameter("text", z.string())], actionResult),
] }
export default TYPERT_REMOTE
