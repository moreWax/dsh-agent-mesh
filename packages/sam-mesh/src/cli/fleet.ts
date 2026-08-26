/**
 * Fleet onboarding: `fleet invite` on any fleet machine produces one 0600
 * file; `fleet join --invite <file>` on a new machine does everything else —
 * hub-mismatch detection (with typed-confirm reset), enrollment, capability
 * provisioning, dsh credentials + profile patch, plugin link, doctor.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { stdin as inp, stdout, stderr, exit } from 'node:process'
import { randomBytes } from 'node:crypto'
import { SamNodeManager } from '../node/index.js'
import { SamClient, generatePairKeys, open } from '../core/index.js'
import {
  buildChecks, decodeFleetInvite, encodeFleetInvite, fleetJoinEnrollment,
  mergeCredentialRefs, mergeProfilePatch, renderDoctor, type FleetInvite,
} from './plan.js'

const execFileAsync = promisify(execFile)
const interactive = () => inp.isTTY === true

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: inp, output: stdout })
  try { return (await rl.question(question)).trim() } finally { rl.close() }
}
async function confirm(question: string, fallbackYes = false): Promise<boolean> {
  if (!interactive()) return false
  const a = (await ask(`${question}${fallbackYes ? ' (Y/n) ' : ' (y/N) '}`)).toLowerCase()
  return a === '' ? fallbackYes : a === 'y' || a === 'yes'
}

function credentialsPath(): string { return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml') }

/** Read one ref from the dsh v1 credentials file (line parse; zero-dep). */
async function readCredentialRef(name: string): Promise<string | undefined> {
  try {
    const text = await readFile(credentialsPath(), 'utf8')
    const match = new RegExp(`^  ${name}: (\\S+)$`, 'm').exec(text)
    return match?.[1]
  } catch { return undefined }
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name)
  return i >= 0 ? rest[i + 1] : undefined
}

// ─── fleet invite ──────────────────────────────────────────────────────────

async function invite(rest: string[]): Promise<void> {
  const nodes = new SamNodeManager()
  const status = await nodes.status()
  const controlPlane = flag(rest, '--control-plane')
    ?? status.enrolledHub
    ?? process.env.SAM_CONTROL_PLANE
    ?? 'https://hub.sam-mesh.dev'
  const serviceName = flag(rest, '--service-name') ?? 'morewax-dsh-task-service'
  // Capability: flag > env > dsh store > offer to mint a fresh fleet secret.
  let capability = flag(rest, '--capability') ?? process.env.SAM_MESH_CAPABILITY ?? await readCredentialRef('MESH_TASK_CAPABILITY')
  if (!capability) {
    if (rest.includes('--generate')) capability = randomBytes(24).toString('hex')
    else { stderr.write('No capability found (--capability, SAM_MESH_CAPABILITY, or MESH_TASK_CAPABILITY in the dsh store). Use --generate to mint a fresh fleet secret.\n'); exit(2) }
  }
  const publicHub = controlPlane.includes('sam-mesh.dev')
  const announcePrivate = rest.includes('--announce-private') ? true : rest.includes('--no-announce-private') ? false : !publicHub
  const bootstrapToken = flag(rest, '--bootstrap-token')
  const inviteData: FleetInvite = {
    version: 1, controlPlane, serviceName, capability, announcePrivate,
    ...(bootstrapToken ? { bootstrapToken } : {}), createdAt: new Date().toISOString(),
  }
  const outPath = flag(rest, '--out') ?? 'fleet-invite.json'
  await writeFile(outPath, encodeFleetInvite(inviteData), { mode: 0o600 })
  await chmod(outPath, 0o600)
  stdout.write(`Invite written to ${outPath} (0600 — contains the fleet capability, treat as a secret)\n`)
  stdout.write(`  hub:      ${controlPlane}\n  service:  ${serviceName}\n  posture:  ${announcePrivate ? 'private/LAN hub' : 'public hub (no RFC1918 announcements)'}\n`)
  const sshTarget = flag(rest, '--ssh')
  if (sshTarget) stdout.write(`\nPlace it on the joining machine:\n  scp ${outPath} ${sshTarget}:~/fleet-invite.json\n`)
  stdout.write(`\nOn the joining machine:\n  sam-mesh fleet join --invite ~/fleet-invite.json\n`)
}

// ─── shared provisioning ───────────────────────────────────────────────────

/** Capability file + dsh credentials merge + profile patch. Shared by
 * file-based join and pairing-based join. */
async function provisionFleet(inviteData: FleetInvite, options: { dataDir: string; profile: string }): Promise<string[]> {
  const notes: string[] = []
  const capPath = join(options.dataDir, 'fleet-capability')
  await writeFile(capPath, inviteData.capability, { mode: 0o600 })
  await chmod(capPath, 0o600)
  notes.push(`capability written to ${capPath} (0600 — call/tail read it automatically)`)
  try {
    const existing = await readFile(credentialsPath(), 'utf8').catch(() => null)
    const merged = mergeCredentialRefs(existing, { MESH_TASK_CAPABILITY: inviteData.capability })
    await mkdir(join(credentialsPath(), '..'), { recursive: true })
    await writeFile(credentialsPath(), merged, { mode: 0o600 })
    await chmod(credentialsPath(), 0o600)
    notes.push(`capability merged into ${credentialsPath()}`)
  } catch (error) { notes.push(`could not write dsh credentials: ${error instanceof Error ? error.message : String(error)}`) }

  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchPath = join(dshHome, 'profiles', options.profile, 'cordis.patch.yml')
  try {
    const existing = await readFile(patchPath, 'utf8').catch(() => null)
    const hasDsh = existing !== null || await readFile(join(dshHome, '.credentials.yaml'), 'utf8').then(() => true).catch(() => false)
    if (!hasDsh) notes.push('dsh not detected — skipped profile patch (install dsh later, then re-run)')
    else {
      const merged = mergeProfilePatch(existing, inviteData)
      if ('conflict' in merged) notes.push(merged.conflict)
      else {
        await mkdir(join(patchPath, '..'), { recursive: true })
        await writeFile(patchPath, merged.text)
        notes.push(`profile patch written: ${patchPath}`)
      }
    }
  } catch (error) { notes.push(`profile patch failed: ${error instanceof Error ? error.message : String(error)}`) }
  return notes
}

// ─── fleet join ────────────────────────────────────────────────────────────

async function joinFleet(rest: string[]): Promise<void> {
  const invitePath = flag(rest, '--invite')
  if (!invitePath) { stderr.write('fleet join requires --invite <file>\n'); exit(2) }
  const decoded = decodeFleetInvite(await readFile(invitePath!, 'utf8'))
  if ('error' in decoded) { stderr.write(`Invalid invite: ${decoded.error}\n`); exit(2) }
  const inviteData = decoded

  const nodes = new SamNodeManager({ controlPlane: inviteData.controlPlane, announcePrivate: inviteData.announcePrivate })
  const status = await nodes.status()
  if (!status.installed) {
    stderr.write('sam-node is not installed. Run: sam-mesh node install\n'); exit(2)
  }

  // Enrollment: same hub → skip; different hub → typed-confirm reset; fresh → enroll.
  const step = fleetJoinEnrollment(status.enrolled, status.enrolledHub, inviteData)
  if (step.action === 'none') {
    stdout.write(`Already enrolled on ${inviteData.controlPlane} — skipping enrollment.\n`)
  } else {
    if (step.action === 'reset-required') {
      stderr.write(`\nThis machine is enrolled on a DIFFERENT hub: ${step.currentHub}\n`)
      stderr.write(`Joining this fleet means leaving it. Reset clears the mesh identity (PeerID survives).\n`)
      const typed = interactive() ? await ask(`Type 'reset' to abandon ${step.currentHub} and continue: `) : ''
      if (typed !== 'reset') { stderr.write('Aborted — no changes made.\n'); exit(2) }
      await execFileAsync(status.binaryPath ?? 'sam-node', ['reset', '--data-dir', status.dataDir], { timeout: 15_000 })
      stdout.write('Identity cleared.\n')
    }
    const session = nodes.beginEnrollment({
      controlPlane: inviteData.controlPlane,
      ...(inviteData.bootstrapToken !== undefined ? { bootstrapToken: inviteData.bootstrapToken } : {}),
    })
    while (session.state === 'starting') await new Promise((r) => setTimeout(r, 200))
    if (session.state === 'awaiting_user') {
      stdout.write(`\nOpen this URL in a browser:\n\n  ${session.verificationUrl}\n\nEnter code: ${session.userCode}\n\nWaiting for authorization...\n`)
    }
    process.once('SIGINT', () => { session.cancel(); stderr.write('\nEnrollment cancelled.\n') })
    await session.done
    if (session.state !== 'complete') { stderr.write(`Enrollment ${session.state}${session.error ? `: ${session.error}` : ''}\n`); exit(1) }
    stdout.write('Enrolled.\n')
  }

  const notes = await provisionFleet(inviteData, { dataDir: status.dataDir, profile: flag(rest, '--profile') ?? 'web' })

  // Node start (offer) — dsh will own it later if installed (option A).
  if (await confirm('Start the mesh node now?', true)) {
    const started = await nodes.start()
    stdout.write(started.ok ? `${started.message}\n` : `${started.error}\n`)
  }

  stdout.write(`\n${notes.join('\n')}\n`)
  // Epilogue: doctor is the verdict.
  try {
    const fresh = await nodes.status()
    let peerCount: number | undefined, serviceCount: number | undefined, localServiceCount = 0
    if (fresh.running) {
      const sam = new SamClient()
      try {
        const mesh = await sam.getMeshInfo()
        peerCount = Array.isArray(mesh.connected_peers) ? mesh.connected_peers.length : 0
        serviceCount = (await sam.discoverRemoteServices({ type: 'mcp' })).length
        localServiceCount = (await sam.listLocalServices()).length
      } catch { peerCount = undefined }
    }
    stdout.write('\n' + renderDoctor(buildChecks({
      installed: fresh.installed, enrolled: fresh.enrolled, running: fresh.running,
      peerCount, serviceCount, localServiceCount,
    })) + '\n')
  } catch { /* doctor is best-effort */ }
}

// ─── discovery-based pairing join (the default path — no files, no ssh) ───

async function discoverFleet(rest: string[]): Promise<void> {
  const sam = new SamClient()
  const services = await sam.discoverRemoteServices({ type: 'mcp' })
  const nameFilter = flag(rest, '--name')
  const fleets = services.filter(s => !nameFilter || s.srv_name === nameFilter)
  stdout.write(JSON.stringify(fleets.map(s => ({ service: s.srv_name, peer: s.peer_id?.slice(0, 12) + '…', peer_id: s.peer_id })), null, 2) + '\n')
  if (!nameFilter) stdout.write('\nJoin one: sam-mesh fleet join --fleet <service-name>\n')
}

async function pairJoin(rest: string[]): Promise<void> {
  const fleetName = flag(rest, '--fleet')
  if (!fleetName) { stderr.write('pair join requires --fleet <service-name> (see: sam-mesh fleet discover)\n'); exit(2) }
  const sam = new SamClient()
  const providers = (await sam.discoverRemoteServices({ type: 'mcp', name: fleetName }))
    .filter(s => s.srv_name === fleetName)
  if (providers.length === 0) { stderr.write(`No provider of '${fleetName}' found in the swarm. Check the name with: sam-mesh fleet discover\n`); exit(2) }
  const peerFlag = flag(rest, '--peer')
  const provider = peerFlag ? providers.find(p => p.peer_id === peerFlag || p.peer_id?.startsWith(peerFlag)) : providers[0]
  if (!provider) { stderr.write(`No provider matching '${peerFlag}' — candidates: ${providers.map(p => p.peer_id).join(', ')}\n`); exit(2) }
  const peer = provider.peer_id!

  // Ephemeral identity for THIS pairing only: the invite comes back sealed
  // to this key; nothing about it is reused.
  stderr.write(`Requesting to join '${fleetName}' via ${peer.slice(0, 12)}…\n`)
  const { randomBytes } = await import('node:crypto')
  const keys = generatePairKeys()
  const requestId = randomBytes(16).toString('hex')
  const label = flag(rest, '--label') ?? `${process.env.USER ?? 'unknown'}@${(await import('node:os')).hostname()}`
  const tool = (name: string, args: Record<string, unknown>) =>
    sam.callRemoteTool({ peer_id: peer, tool_name: `mcp://${fleetName}/${name}`, arguments: args })
  await tool('fleet_pair_request', { requestId, publicKey: keys.publicKeyX, label })
  stdout.write(`Request sent as '${label}'. An operator must approve it (sam-mesh fleet approvals / approve).\nWaiting (Ctrl+C to abort)...\n`)
  const deadline = Date.now() + 10 * 60_000
  for (;;) {
    if (Date.now() > deadline) { stderr.write('Timed out waiting for approval — re-run to try again.\n'); exit(1) }
    await new Promise(r => setTimeout(r, 2000))
    let poll: { state: string; sealed?: Parameters<typeof open>[0] }
    try { poll = (await tool('fleet_pair_poll', { requestId })) as typeof poll } catch { continue }
    if (poll.state === 'approved' && poll.sealed) {
      const inviteJson = open(poll.sealed, keys.privateKey)
      const decoded = decodeFleetInvite(inviteJson)
      if ('error' in decoded) { stderr.write(`Approval carried an invalid invite: ${decoded.error}\n`); exit(1) }
      stdout.write('Approved — invite received (sealed to this pairing).\n')
      const nodes = new SamNodeManager({ controlPlane: decoded.controlPlane, announcePrivate: decoded.announcePrivate })
      const status = await nodes.status()
      const notes = await provisionFleet(decoded, { dataDir: status.dataDir, profile: flag(rest, '--profile') ?? 'web' })
      stdout.write(notes.join('\n') + '\n')
      stdout.write(`\nYou hold the '${fleetName}' capability. Try: sam-mesh peers | sam-mesh call <peer-prefix> task_get '{"taskId":"…"}'\n`)
      return
    }
    if (poll.state === 'unknown') { stderr.write('Request expired or was rejected — re-run to try again.\n'); exit(1) }
  }
}

async function approvals(rest: string[]): Promise<void> {
  const fleetName = flag(rest, '--fleet') ?? 'morewax-dsh-task-service'
  const peerArg = flag(rest, '--peer')
  const sam = new SamClient()
  const providers = (await sam.discoverRemoteServices({ type: 'mcp', name: fleetName })).filter(s => s.srv_name === fleetName)
  const provider = peerArg ? providers.find(p => p.peer_id === peerArg || p.peer_id?.startsWith(peerArg)) : providers[0]
  if (!provider?.peer_id) { stderr.write(`No provider of '${fleetName}' found.\n`); exit(2) }
  const { readFileSync } = await import('node:fs')
  let capability = process.env.SAM_MESH_CAPABILITY
  if (!capability) try { capability = readFileSync(join(homedir(), '.config', 'sam-mesh', 'fleet-capability'), 'utf8').trim() } catch { capability = undefined }
  const call = (name: string, args: Record<string, unknown>) =>
    sam.callRemoteTool({ peer_id: provider.peer_id!, tool_name: `mcp://${fleetName}/${name}`, arguments: { ...args, ...(capability ? { _capability: capability } : {}) } })
  const sub = rest[0]
  if (sub === 'approve' || sub === 'reject') {
    const requestId = rest[1]
    if (!requestId) { stderr.write(`fleet approvals ${sub} requires a requestId\n`); exit(2) }
    const result = await call(`fleet_pair_${sub}`, { requestId, ...(sub === 'approve' ? { approvedBy: process.env.USER ?? 'operator' } : {}) })
    stdout.write(JSON.stringify(result) + '\n')
    return
  }
  stdout.write(JSON.stringify(await call('fleet_pair_list', {}), null, 2) + '\n')
}

export async function runFleet(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'invite') return invite(rest)
  if (sub === 'discover') return discoverFleet(rest)
  if (sub === 'approvals') return approvals(rest)
  if (sub === 'join') {
    if (rest.includes('--fleet')) return pairJoin(rest)
    return joinFleet(rest)
  }
  stderr.write(`Usage: sam-mesh fleet <invite|join>

  fleet invite [--control-plane <url>] [--service-name <name>]
               [--capability <secret> | --generate] [--out <file>]
               [--ssh user@host] [--bootstrap-token <tok>]
               Create a fleet invite (0600 file) on any fleet machine.

  fleet join --invite <file> [--profile <dsh-profile>]
               Join a fleet: detects hub mismatches, enrolls, provisions the
               capability (CLI + dsh store), writes the dsh profile patch,
               starts the node, and ends with doctor.
`)
  exit(2)
}
