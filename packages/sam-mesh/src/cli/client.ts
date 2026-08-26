#!/usr/bin/env node
/**
 * Standalone mesh client: talk to the local sam-node without a running dsh.
 * This is the reference client for the capability plane — on any enrolled
 * machine (laptop, jump host, another server) it lists and calls what the
 * mesh exposes, including capabilities a remote dsh published.
 *
 *   dsh-agent-mesh status                     mesh + node snapshot
 *   dsh-agent-mesh services [--filter <json>] discover remote services
 *   dsh-agent-mesh tools [--filter <json>]    remote tool roster
 *   dsh-agent-mesh models                     mesh inference models
 *   dsh-agent-mesh call <peer> <tool> [json-args]   call a remote tool, print the structured result
 *
 * Connection env: SAM_SOCKET (default ~/.config/sam-mesh/sam.sock),
 *                 SAM_TCP_URL (fallback http://127.0.0.1:8080).
 */
import { join } from "node:path"
import { homedir } from "node:os"
import { stdout, stderr, exit } from "node:process"
import { SamClient } from "../core/index.js"

function usage(): never {
  console.log(`Usage: dsh-agent-mesh <status|services|tools|models|call> [args]

Commands:
  status                      Mesh + node snapshot
  services [--filter <json>]  Discover remote services
  tools [--filter <json>]     Remote tool roster
  models                      Mesh inference models
  call <peer> <tool> [json]   Call a remote tool (peer from the tools roster); prints the structured result

Connection: SAM_SOCKET (default ~/.config/sam-mesh/sam.sock), SAM_TCP_URL (default http://127.0.0.1:8080).`)
  exit(0)
}

function parseJson(text: string | undefined, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!text) return fallback
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object")
    return value as Record<string, unknown>
  } catch (error) {
    stderr.write(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}
`)
    exit(2)
  }
}

function print(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}
`)
}

function client(): SamClient {
  const socketPath = process.env.SAM_SOCKET ?? join(homedir(), ".config", "sam-mesh", "sam.sock")
  const tcpUrl = process.env.SAM_TCP_URL ?? "http://127.0.0.1:8080"
  return new SamClient({ socketPath, tcpUrl, preferSocket: true, timeoutMs: 15_000 })
}

export async function runClient(args: string[]): Promise<void> {
  const [command, ...rest] = args
  const sam = client()
  switch (command) {
    case "status": {
      const [mesh, local] = await Promise.all([sam.getMeshInfo(), sam.listLocalServices()])
      print({ mesh, localServices: local })
      return
    }
    case "services": {
      print(await sam.discoverRemoteServices(parseJson(rest[1], {})))
      return
    }
    case "tools": {
      print(await sam.findRemoteTools(parseJson(rest[1], {})))
      return
    }
    case "models": {
      print(await sam.listModels())
      return
    }
    case "call": {
      const [peer, rawTool, argsText] = rest
      if (!peer || !rawTool) { stderr.write("call requires <peer> and <tool> — see the services roster for peer ids\n"); exit(2) }
      // Auto-qualify a bare name against the target peer's discovered
      // services: one match -> mcp://<service>/<tool>; several -> list them.
      // Explicit URIs (contain '://') pass through untouched.
      let tool = rawTool
      if (!rawTool.includes("://")) {
        const services = (await sam.discoverRemoteServices({ type: "mcp" })).filter(s => s.peer_id === peer)
        const matches = services.filter(s => s.srv_name)
        if (matches.length === 1) {
          tool = `mcp://${matches[0]!.srv_name}/${rawTool}`
          stderr.write(`(resolved ${rawTool} -> ${tool})\n`)
        } else if (matches.length > 1) {
          stderr.write(`ambiguous tool ${rawTool}: ${peer} exposes ${matches.map(m => `mcp://${m.srv_name}/`).join(", ")} — use the full URI form\n`)
          exit(2)
        } else {
          stderr.write(`no remote service found for ${peer}; use the full URI form, e.g. mcp://<service>/${rawTool}\n`)
          exit(2)
        }
      }
      print(await sam.callRemoteTool({ peer_id: peer, tool_name: tool, arguments: parseJson(argsText, {}) }))
      return
    }
    default:
      usage()
  }
}
