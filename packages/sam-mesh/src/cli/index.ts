#!/usr/bin/env node
/**
 * sam-mesh — the SAM mesh client + node kit. Talks to the local sam-node
 * (no dsh required) and manages the node's lifecycle so any machine can
 * join the mesh from one binary.
 *
 *   sam-mesh status|services|tools|models|call ...   mesh client (see below)
 *   sam-mesh node status                             installed/enrolled/running
 *   sam-mesh node start                              start the node daemon (idempotent)
 *   sam-mesh node stop                               stop the node daemon (idempotent)
 *   sam-mesh node join [--control-plane <url>]       device-flow enrollment; prints URL + code
 *
 * Env: SAM_SOCKET, SAM_TCP_URL (client), SAM_NODE (binary override),
 *      SAM_DATA_DIR (default ~/.config/sam-mesh), SAM_CONTROL_PLANE.
 */
import { stdout, stderr, exit, argv } from 'node:process'
import { runClient } from './client.js'
import { SamNodeManager, DEFAULT_CONTROL_PLANE } from '../node/index.js'

const CLIENT_COMMANDS = new Set(['status', 'services', 'tools', 'models', 'call'])

function manager(): SamNodeManager {
  return new SamNodeManager({
    ...(process.env.SAM_NODE ? { samNode: process.env.SAM_NODE } : {}),
    ...(process.env.SAM_DATA_DIR ? { dataDir: process.env.SAM_DATA_DIR } : {}),
    ...(process.env.SAM_CONTROL_PLANE ? { controlPlane: process.env.SAM_CONTROL_PLANE } : {}),
  })
}

function print(value: unknown): void { stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

async function runNode(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const nodes = manager()
  switch (sub) {
    case 'status': {
      print(await nodes.status())
      return
    }
    case 'start': case 'stop': {
      const result = await nodes[sub]()
      print(result)
      if (!result.ok) exit(1)
      return
    }
    case 'join': {
      let controlPlane = process.env.SAM_CONTROL_PLANE ?? DEFAULT_CONTROL_PLANE
      const flagIndex = rest.indexOf('--control-plane')
      if (flagIndex >= 0 && rest[flagIndex + 1]) controlPlane = rest[flagIndex + 1]!
      const status = await nodes.status()
      if (status.enrolled) { stderr.write(`This node already has an identity in ${status.dataDir} (reset stays a deliberate terminal operation).\n`); exit(2) }
      if (!status.installed) { stderr.write('sam-node is not installed or not on PATH.\n'); exit(2) }
      const session = nodes.beginEnrollment({ controlPlane })
      stderr.write(`Enrollment session ${session.sessionId} — waiting for the device flow...\n`)
      while (session.state === 'starting') await new Promise((r) => setTimeout(r, 200))
      if (session.state === 'awaiting_user') {
        stdout.write(`\nOpen this URL in a browser:\n\n  ${session.verificationUrl}\n\nEnter code: ${session.userCode}\n\nWaiting for authorization...\n`)
      }
      process.once('SIGINT', () => { session.cancel(); stderr.write('\nEnrollment cancelled.\n') })
      await session.done
      if (session.state === 'complete') { stdout.write('Enrolled. Start the node with: sam-mesh node start\n'); return }
      stderr.write(`Enrollment ${session.state}${session.error ? `: ${session.error}` : ''}\n`)
      exit(session.state === 'cancelled' ? 130 : 1)
    }
    default:
      stderr.write('Usage: sam-mesh node <status|start|stop|join> [--control-plane <url>]\n')
      exit(2)
  }
}

const [, , command, ...rest] = argv
if (!command || command === '--help' || command === '-h') {
  stdout.write(`Usage: sam-mesh <status|services|tools|models|call|node> [args]

Mesh client (local node must be running):
  status                      Mesh + node snapshot
  services [--filter <json>]  Discover remote services
  tools [--filter <json>]     Remote tool roster
  models                      Mesh inference models
  call <peer> <tool> [json]   Call a remote tool

Node kit:
  node status                 installed / enrolled / running
  node start | node stop      daemon lifecycle (idempotent)
  node join [--control-plane] device-flow enrollment; prints URL + code
`)
  exit(0)
}
if (command === 'node') await runNode(rest)
else if (CLIENT_COMMANDS.has(command)) await runClient([command, ...rest])
else { stderr.write(`Unknown command: ${command}\n`); exit(2) }
