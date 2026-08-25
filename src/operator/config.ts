import { homedir } from "node:os"
import { resolve } from "node:path"
import type { AgentMeshConfig, AgentMeshConfigInput } from "./types.js"

const DEFAULT_SOCKET = "~/.config/sam-mesh/sam.sock"
const DEFAULT_TCP = "http://127.0.0.1:8080"

function socketPath(value: string | false): string | false {
  if (value === false) return false
  const clean = value.trim()
  if (!clean) throw new TypeError("socketPath must be a non-empty path or false")
  if (clean === "~") return homedir()
  if (clean.startsWith("~/")) return resolve(homedir(), clean.slice(2))
  return resolve(clean)
}

/** Parse untrusted Cordis config, expand `~`, reject unsafe URLs, and discard unknown keys. */
export function parseAgentMeshConfig(value: AgentMeshConfigInput | unknown = {}): AgentMeshConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("agent mesh config must be an object")
  const input = value as Record<string, unknown>
  if (input.preferSocket !== undefined && typeof input.preferSocket !== "boolean") throw new TypeError("preferSocket must be boolean")
  if (input.socketPath !== undefined && input.socketPath !== false && typeof input.socketPath !== "string") throw new TypeError("socketPath must be a string or false")
  if (input.nodeCredentialRef !== undefined && (typeof input.nodeCredentialRef !== "string" || !input.nodeCredentialRef.trim())) throw new TypeError("nodeCredentialRef must be a non-empty string")
  if ("apiToken" in input || "nodeToken" in input) throw new TypeError("raw node tokens are forbidden in config; use nodeCredentialRef and ctx.credentials")
  const timeoutMs = input.timeoutMs ?? 30_000
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive integer")
  const tcpUrl = input.tcpUrl ?? DEFAULT_TCP
  if (typeof tcpUrl !== "string") throw new TypeError("tcpUrl must be a string")
  let url: URL
  try { url = new URL(tcpUrl) } catch { throw new TypeError("tcpUrl must be an absolute HTTP URL") }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("tcpUrl must use http or https")
  if (url.username || url.password) throw new TypeError("tcpUrl must not contain credentials")
  const preferSocket = (input.preferSocket as boolean | undefined) ?? true
  const configuredSocket = input.socketPath === undefined ? DEFAULT_SOCKET : input.socketPath as string | false
  const result: AgentMeshConfig = { socketPath: preferSocket ? socketPath(configuredSocket) : false, tcpUrl: url.toString().replace(/\/$/, ""), preferSocket, timeoutMs }
  if (input.nodeCredentialRef !== undefined) result.nodeCredentialRef = (input.nodeCredentialRef as string).trim()
  return Object.freeze(result)
}
