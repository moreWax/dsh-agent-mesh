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
import { SamClient } from '../core/index.js'
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

  // Capability, both consumption paths: standalone CLI file + dsh managed store.
  const capPath = join(status.dataDir, 'fleet-capability')
  await writeFile(capPath, inviteData.capability, { mode: 0o600 })
  await chmod(capPath, 0o600)
  let credsNote = ''
  try {
    const existing = await readFile(credentialsPath(), 'utf8').catch(() => null)
    const merged = mergeCredentialRefs(existing, { MESH_TASK_CAPABILITY: inviteData.capability })
    await mkdir(join(credentialsPath(), '..'), { recursive: true })
    await writeFile(credentialsPath(), merged, { mode: 0o600 })
    await chmod(credentialsPath(), 0o600)
    credsNote = `capability merged into ${credentialsPath()}`
  } catch (error) { credsNote = `could not write dsh credentials: ${error instanceof Error ? error.message : String(error)}` }

  // dsh profile patch (only when dsh is present on this machine).
  const profile = flag(rest, '--profile') ?? 'web'
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const patchPath = join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  let patchNote = 'dsh not detected — skipped profile patch (install dsh later, then re-run with --only-dsh)'
  try {
    const existing = await readFile(patchPath, 'utf8').catch(() => null)
    const hasDsh = existing !== null || await readFile(join(dshHome, '.credentials.yaml'), 'utf8').then(() => true).catch(() => false)
    if (hasDsh) {
      const merged = mergeProfilePatch(existing, inviteData)
      if ('conflict' in merged) patchNote = merged.conflict
      else {
        await mkdir(join(patchPath, '..'), { recursive: true })
        await writeFile(patchPath, merged.text)
        patchNote = `profile patch written: ${patchPath}`
      }
    }
  } catch (error) { patchNote = `profile patch failed: ${error instanceof Error ? error.message : String(error)}` }

  // Node start (offer) — dsh will own it later if installed (option A).
  if (await confirm('Start the mesh node now?', true)) {
    const started = await nodes.start()
    stdout.write(started.ok ? `${started.message}\n` : `${started.error}\n`)
  }

  stdout.write(`\n${credsNote}\n${patchNote}\n`)
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

export async function runFleet(args: string[]): Promise<void> {
  const [sub, ...rest] = args
  if (sub === 'invite') return invite(rest)
  if (sub === 'join') return joinFleet(rest)
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
