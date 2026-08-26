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
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { stdout, stderr, exit } from "node:process"
import { SamClient } from "../core/index.js"
import { expandPeer, parseWatch, shortId, withCapability } from "./plan.js"

function usage(): never {
  console.log(`Usage: dsh-agent-mesh <status|services|tools|models|call> [args]

Commands:
  status                      Mesh + node snapshot
  services [--filter <json>]  Discover remote services
  tools [--filter <json>]     Remote tool roster
  models                      Mesh inference models
  peers                       Connected peers, short ids + the services each offers
  call <peer> <tool> [json]   Call a remote tool (peer id or unique prefix; bare tool names auto-qualify)\n  tail <peer> <task-id>       Stream a remote task's events until it settles (Ctrl+C detaches)

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

async function resolvePeer(sam: SamClient, peerArg: string): Promise<string> {
  const mesh = await sam.getMeshInfo()
  const knownPeers = Array.isArray(mesh.connected_peers) ? mesh.connected_peers : []
  const match = expandPeer(peerArg, knownPeers)
  if (!match.ok) {
    stderr.write(match.candidates.length > 0
      ? `ambiguous peer "${peerArg}": ${match.candidates.map(shortId).join(", ")}\n`
      : `unknown peer "${peerArg}" — try: sam-mesh peers\n`)
    exit(2)
  }
  return match.peer
}

function readCapability(rest: string[]): string | undefined {
  const i = rest.indexOf("--capability")
  if (i >= 0 && rest[i + 1]) return rest[i + 1]
  if (process.env.SAM_MESH_CAPABILITY) return process.env.SAM_MESH_CAPABILITY
  // Fleet-join provisioned file (0600), written by `sam-mesh fleet join`.
  try {
    const value = readFileSync(join(homedir(), ".config", "sam-mesh", "fleet-capability"), "utf8").trim()
    return value || undefined
  } catch { return undefined }
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
    case "peers": {
      const mesh = await sam.getMeshInfo()
      const services = await sam.discoverRemoteServices({ type: "mcp" })
      const peers = Array.isArray(mesh.connected_peers) ? mesh.connected_peers : []
      print(peers.map((peer: string) => ({
        peer: shortId(peer),
        peer_id: peer,
        services: services.filter(s => s.peer_id === peer).map(s => s.srv_name),
      })))
      return
    }
    case "call": {
      const [peerArg, rawTool, argsText] = rest
      if (!peerArg || !rawTool) { stderr.write("call requires <peer> and <tool> — see the services roster for peer ids\n"); exit(2) }
      const peer = await resolvePeer(sam, peerArg)
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
      print(await sam.callRemoteTool({ peer_id: peer, tool_name: tool, arguments: withCapability(parseJson(argsText, {}), readCapability(rest)) }))
      return
    }
    case "tail": {
      const [peerArg, taskId] = rest
      if (!peerArg || !taskId) { stderr.write("tail requires <peer> and <task-id>\n"); exit(2) }
      const peer = await resolvePeer(sam, peerArg)
      const services = (await sam.discoverRemoteServices({ type: "mcp" })).filter(s => s.peer_id === peer && s.srv_name)
      if (services.length !== 1) {
        stderr.write(services.length === 0
          ? `peer ${shortId(peer)} announces no services — nothing to tail\n`
          : `peer ${shortId(peer)} announces ${services.length} services; tail needs exactly one task service\n`)
        exit(2)
      }
      const watchTool = `mcp://${services[0]!.srv_name}/task_watch`
      stderr.write(`tailing ${taskId} on ${shortId(peer)} via ${watchTool} — Ctrl+C to detach\n`)
      let cursor: string | undefined
      for (;;) {
        const res = await sam.callRemoteTool({
          peer_id: peer, tool_name: watchTool,
          arguments: withCapability({ taskId, waitMs: 2000, ...(cursor ? { cursor } : {}) }, readCapability(rest)),
        })
        const watch = parseWatch(res.structuredContent)
        for (const event of watch.events) stdout.write(`${JSON.stringify(event)}\n`)
        cursor = watch.cursor ?? cursor
        if (watch.terminal) { stdout.write(`task ${watch.status}\n`); break }
      }
      return
    }
    default:
      usage()
  }
}
