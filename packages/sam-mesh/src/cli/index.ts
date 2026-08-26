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
 *   sam-mesh node join --bootstrap-token-path <file>   pre-shared-token enrollment (no browser)
 *   sam-mesh node install                            run the official sam-node installer (consent = invoking it)
 *   sam-mesh token mint ...                          mint a hub bootstrap token + print the paste block
 *
 * Env: SAM_SOCKET, SAM_TCP_URL (client), SAM_NODE (binary override),
 *      SAM_DATA_DIR (default ~/.config/sam-mesh), SAM_CONTROL_PLANE.
 */
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { stdout as out, stdin as inp, stdout, stderr, exit, argv } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { runClient } from './client.js'
import { SamNodeManager, DEFAULT_CONTROL_PLANE } from '../node/index.js'
import { INSTALL_INSTRUCTION, QR_MISSING_HINT, SAM_INSTALL_CMD, buildChecks, expandPeer, formatMintBlock, formatSshHandoff, nextJoinStep, renderDoctor } from './plan.js'
import { AGENT_SKILL } from './skill-doc.js'

const CLIENT_COMMANDS = new Set(['status', 'peers', 'services', 'tools', 'models', 'call', 'tail'])

function manager(): SamNodeManager {
  return new SamNodeManager({
    ...(process.env.SAM_NODE ? { samNode: process.env.SAM_NODE } : {}),
    ...(process.env.SAM_DATA_DIR ? { dataDir: process.env.SAM_DATA_DIR } : {}),
    ...(process.env.SAM_CONTROL_PLANE ? { controlPlane: process.env.SAM_CONTROL_PLANE } : {}),
    // Public-hub posture: SAM_ANNOUNCE_PRIVATE=false keeps RFC1918/ULA
    // addresses out of the swarm (upstream default is true — right for LANs).
    ...(process.env.SAM_ANNOUNCE_PRIVATE !== undefined ? { announcePrivate: process.env.SAM_ANNOUNCE_PRIVATE !== 'false' } : {}),
  })
}

function print(value: unknown): void { stdout.write(`${JSON.stringify(value, null, 2)}\n`) }

const interactive = (): boolean => inp.isTTY === true

/** y/N prompt; non-interactive stdin answers 'n' (no surprise network fetches in scripts). */
async function confirm(question: string, fallbackYes = false): Promise<boolean> {
  if (!interactive()) return false
  const rl = createInterface({ input: inp, output: out })
  try {
    const answer = (await rl.question(`${question}${fallbackYes ? ' (Y/n) ' : ' (y/N) '}`)).trim().toLowerCase()
    return answer === '' ? fallbackYes : answer === 'y' || answer === 'yes'
  } finally { rl.close() }
}

function runInstaller(): Promise<void> {
  stderr.write(`+ ${SAM_INSTALL_CMD}\n`)
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', SAM_INSTALL_CMD], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`installer exited with ${code}`)))
  })
}

async function runNode(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  const nodes = manager()
  switch (sub) {
    case 'status': {
      print(await nodes.status())
      return
    }
    case 'install': {
      stderr.write(`+ ${SAM_INSTALL_CMD}\n`)
      const child = spawn('bash', ['-c', SAM_INSTALL_CMD], { stdio: 'inherit' })
      child.once('error', (error) => { stderr.write(`installer failed: ${error.message}\n`); exit(1) })
      void child.once('exit', async (code) => {
        if (code !== 0) { stderr.write(`installer exited with ${code}\n`); exit(1) }
        print(await manager().status())
      })
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
      const tokenIndex = rest.indexOf('--bootstrap-token-path')
      const bootstrapTokenPath = tokenIndex >= 0 ? rest[tokenIndex + 1] : undefined
      const status = await nodes.status()
      const step = nextJoinStep(status, interactive())
      if (step.action === 'already-enrolled') { stderr.write(`This node already has an identity in ${step.dataDir ?? status.dataDir} (reset stays a deliberate terminal operation).\n`); exit(2) }
      if (step.action === 'install-offer') {
        if (!interactive()) { stderr.write(INSTALL_INSTRUCTION + '\n'); exit(2) }
        if (!(await confirm(`sam-node is not installed. Install it now with the official installer?`))) {
          stderr.write(INSTALL_INSTRUCTION + '\n'); exit(2)
        }
        try { await runInstaller() } catch (error) { stderr.write(`installer failed: ${error instanceof Error ? error.message : String(error)}\n`); exit(1) }
        const recheck = await nodes.status()
        if (!recheck.installed) { stderr.write('installer finished but sam-node is still not on PATH.\n'); exit(1) }
      }
      // Bootstrap mode: read the token from its file (operator-placed, 0600)
      // and hand the manager the VALUE — the manager owns the file it passes
      // to sam-node from then on.
      const bootstrapToken = bootstrapTokenPath !== undefined
        ? (await readFile(bootstrapTokenPath!, 'utf8')).trim()
        : undefined
      const session = nodes.beginEnrollment({ controlPlane, ...(bootstrapToken !== undefined ? { bootstrapToken } : {}) })
      stderr.write(`Enrollment session ${session.sessionId} — waiting for the device flow...\n`)
      while (session.state === 'starting') await new Promise((r) => setTimeout(r, 200))
      if (session.state === 'awaiting_user') {
        stdout.write(`\nOpen this URL in a browser:\n\n  ${session.verificationUrl}\n\nEnter code: ${session.userCode}\n\nWaiting for authorization...\n`)
      }
      process.once('SIGINT', () => { session.cancel(); stderr.write('\nEnrollment cancelled.\n') })
      await session.done
      if (session.state === 'complete') {
        stdout.write('Enrolled.\n')
        const started = await confirm('Start the node now?', true)
          ? await nodes.start()
          : undefined
        if (started) stdout.write(started.ok ? `${started.message}\n` : `${started.error}\n`)
        else stdout.write('Start later with: sam-mesh node start\n')
        // Epilogue: turn success into an invitation — what am I on, who is here.
        try {
          if (started?.ok) {
            const sam = new (await import('../core/index.js')).SamClient()
            const mesh = await sam.getMeshInfo()
            const services = await sam.discoverRemoteServices({ type: 'mcp' })
            const peerCount = Array.isArray(mesh.connected_peers) ? mesh.connected_peers.length : 0
            stdout.write(`\nYou are on ${controlPlane}.\n`)
            stdout.write(`Peers connected: ${peerCount}. Services visible to you: ${services.length}.\n`)
            stdout.write('Try: npx @morewax/sam-mesh doctor   |   npx @morewax/sam-mesh services\n')
          }
        } catch { /* epilogue is best-effort */ }
        return
      }
      stderr.write(`Enrollment ${session.state}${session.error ? `: ${session.error}` : ''}\n`)
      exit(session.state === 'cancelled' ? 130 : 1)
    }
    default:
      stderr.write('Usage: sam-mesh node <status|install|start|stop|join> [--control-plane <url>] [--bootstrap-token-path <file>]\n')
      exit(2)
  }
}

const [, , command, ...rest] = argv
if (!command || command === '--help' || command === '-h') {
  stdout.write(`Usage: sam-mesh <status|peers|services|tools|models|call|tail|node|token|doctor|skill> [args]

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
else if (command === 'token' && rest[0] === 'mint') {
  // Hub-operator side of bootstrap enrollment: mint a token via the CP admin
  // API and print the exact paste block for the joining machine. Minting is
  // the human gate; this just makes the handoff copy-paste clean.
  const cpIndex = rest.indexOf('--control-plane')
  const controlPlane = rest[cpIndex + 1] ?? process.env.SAM_CONTROL_PLANE
  const atPath = rest.indexOf('--admin-token-path')
  const role = rest.indexOf('--role') >= 0 ? rest[rest.indexOf('--role') + 1]! : 'sam:role:node'
  if (!controlPlane || atPath < 0 || !rest[atPath + 1]) {
    stderr.write('Usage: sam-mesh token mint --control-plane <url> --admin-token-path <file> [--role sam:role:node|sam:role:router] [--max-usages <n>]\n')
    exit(2)
  }
  const usages = rest.indexOf('--max-usages')
  const body = {
    role,
    description: `sam-mesh CLI mint ${new Date().toISOString()}`,
    ...(usages >= 0 && rest[usages + 1] ? { max_usages: Number(rest[usages + 1]) } : {}),
  }
  const adminToken = (await readFile(rest[atPath + 1]!, 'utf8')).trim()
  const resp = await fetch(`${controlPlane.replace(/\/$/, '')}/admin/bootstrap-tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) { stderr.write(`mint failed: HTTP ${resp.status} ${await resp.text()}\n`); exit(1) }
  const minted = await resp.json() as { token?: string; expires_at?: string }
  if (!minted.token) { stderr.write('mint failed: response carried no token\n'); exit(1) }
  stdout.write(`minted ${role}, expires ${minted.expires_at ?? 'n/a'}\n\n`)
  stdout.write(formatMintBlock(minted.token, controlPlane))
  const sshIndex = rest.indexOf('--ssh')
  if (sshIndex >= 0 && rest[sshIndex + 1]) {
    stdout.write('\n# or place it over ssh:\n')
    stdout.write(formatSshHandoff(minted.token, rest[sshIndex + 1]!) + '\n')
  }
  if (rest.includes('--qr')) {
    const child = spawn('qrencode', ['-t', 'ANSIUTF8', formatMintBlock(minted.token, controlPlane)], { stdio: 'inherit' })
    child.once('error', () => stderr.write(`\n${QR_MISSING_HINT}\n`))
  }
}
else if (command === 'doctor') {
  const nodes = manager()
  let sam: import('../core/index.js').SamClient | undefined
  try { sam = new (await import('../core/index.js')).SamClient() } catch { /* daemon down paths still report */ }
  const status = await nodes.status()
  let peerCount: number | undefined
  let serviceCount: number | undefined
  if (status.running && sam) {
    try {
      const mesh = await sam.getMeshInfo()
      peerCount = Array.isArray(mesh.connected_peers) ? mesh.connected_peers.length : 0
      serviceCount = (await sam.discoverRemoteServices({ type: 'mcp' })).length
    } catch { peerCount = undefined }
  }
  let localServiceCount = 0
  if (status.running && sam) { try { localServiceCount = (await sam.listLocalServices()).length } catch { localServiceCount = 0 } }
  const checks = buildChecks({
    installed: status.installed, enrolled: status.enrolled, running: status.running,
    peerCount, serviceCount, localServiceCount,
  })
  stdout.write(renderDoctor(checks) + '\n')
}
else if (command === 'skill') stdout.write(AGENT_SKILL + '\n')
else if (command === 'node') await runNode(rest)
else if (CLIENT_COMMANDS.has(command)) await runClient([command, ...rest])
else { stderr.write(`Unknown command: ${command}\n`); exit(2) }
