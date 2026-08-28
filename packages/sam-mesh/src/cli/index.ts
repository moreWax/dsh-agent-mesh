#!/usr/bin/env node
/**
 * sam-mesh — the SAM mesh client + node kit. Talks to the local sam-node
 * (no dsh required) and manages the node's lifecycle so any machine can
 * join the mesh from one binary.
 *
 *   sam-mesh status|services|tools|models|call ...   mesh client (see below)
 *   sam-mesh node status                             installed/enrolled/running
 *   sam-mesh node binary                             every usable sam-node; ★ = suggested
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
import { existsSync } from 'node:fs'
import { stdout as out, stdin as inp, stdout, stderr, exit, argv } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { runClient } from './client.js'
import { SamNodeManager, DEFAULT_CONTROL_PLANE } from '../node/index.js'
import { INSTALL_INSTRUCTION, QR_MISSING_HINT, SAM_INSTALL_CMD, buildChecks, expandPeer, formatMintBlock, formatSshHandoff, nextJoinStep, renderDoctor } from './plan.js'
import { AGENT_SKILL } from './skill-doc.js'
import { runFleet } from './fleet.js'

async function runRuntime(args: string[]): Promise<void> {
  const sub = args[0]
  const dataDir = process.env.SAM_DATA_DIR ?? `${process.env.HOME}/.config/sam-mesh`
  const rt = await import('../node/llama-runtime.js')
  if (sub === 'status' || sub === undefined) {
    try {
      const v = await rt.resolveVendoredLlama(dataDir)
      stdout.write(`vendored runtime: llama.cpp ${v.tag} (${v.binary})\n`)
    } catch (error) { stdout.write(`vendored runtime: unavailable — ${error instanceof Error ? error.message : String(error)}\n`) }
    const models = await rt.listModelStore(dataDir)
    stdout.write(models.length === 0 ? 'model store: empty\n' : `model store (${dataDir}/models):\n`)
    for (const m of models) stdout.write(`  ${(m.bytes / 1e9).toFixed(2)} GB  ${m.file}\n`)
    return
  }
  if (sub === 'models') {
    for (const m of await rt.listModelStore(dataDir)) stdout.write(`${(m.bytes / 1e9).toFixed(2)} GB  ${m.file}\n`)
    return
  }
  if (sub === 'pull') {
    const specArg = args[1]
    if (!specArg) { stderr.write('Usage: sam-mesh runtime pull \'<org/repo[:quant|/file.gguf]>\'\n'); exit(2) }
    const spec = rt.parseModelSpec(specArg)
    if (spec.kind !== 'hf') { stderr.write('pull needs a Hugging Face ref (org/repo[:quant]); paths need no pull.\n'); exit(2) }
    const resolved = await rt.resolveHfFile(spec)
    const dest = rt.modelStorePath(dataDir, spec.repo, resolved.file)
    if (existsSync(dest)) { stdout.write(`already in store: ${dest}\n`); return }
    stdout.write(`pulling ${spec.repo}/${resolved.file}${resolved.size !== undefined ? ` (${(resolved.size / 1e9).toFixed(2)} GB)` : ''} …\n`)
    let last = 0
    const done = await rt.downloadModel(dataDir, spec, { onProgress: (p) => {
      const pct = p.total ? Math.round((p.downloaded / p.total) * 100) : 0
      if (pct >= last + 10) { last = pct; stdout.write(`  ${pct}% (${(p.downloaded / 1e9).toFixed(2)} GB)\n`) }
    } })
    stdout.write(`stored: ${done.path} (${(done.bytes / 1e9).toFixed(2)} GB)\nServe it: sam-mesh inference-proxy with a runtime serve row, or the card → Share models.\n`)
    return
  }
  stderr.write('Usage: sam-mesh runtime <status|models|pull>\n'); exit(2)
}

async function runInferenceProxy(args: string[]): Promise<void> {
  const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
  let target = flag('--target')
  if (!target) { stderr.write('Usage: sam-mesh inference-proxy --target <url|auto> [--host 127.0.0.1] [--port 4100] [--announce-name <name>] [--allow-ungated]\n'); exit(2) }
  if (target === 'auto') {
    const { detectInferenceBackends } = await import('../node/inference-proxy.js')
    const auto = await detectInferenceBackends().catch((error: unknown) => { stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); exit(2) })
    target = auto.target
    stderr.write(`[inference-proxy] auto-detected backend: ${auto.found[0]!.name} at ${target}${auto.ambiguous ? ` (also found: ${auto.found.slice(1).map(b => `${b.name} ${b.url}`).join(', ')})` : ''}\n`)
  }
  const host = flag('--host') ?? '127.0.0.1'
  const port = Number(flag('--port') ?? '4100')
  if (!Number.isInteger(port) || port < 1 || port > 65535) { stderr.write('--port must be an integer 1..65535\n'); exit(2) }
  const capability = process.env.SAM_INFERENCE_CAPABILITY ?? ''
  const allowUngated = args.includes('--allow-ungated')
  if (!capability && !allowUngated) {
    stderr.write('Refusing to serve UNGATED inference on the mesh: set SAM_INFERENCE_CAPABILITY (the fleet capability) or pass --allow-ungated explicitly.\n')
    exit(2)
  }
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    stderr.write(`Refusing to bind ${host}: the gate proxy must stay loopback-only; the mesh is the only inbound path.\n`)
    exit(2)
  }
  const { createInferenceProxyServer, startAnnounceLoop } = await import('../node/inference-proxy.js')
  const log = (line: string) => stderr.write(`[inference-proxy] ${line}\n`)
  const server = createInferenceProxyServer({
    host, port, target,
    ...(process.env.SAM_INFERENCE_UPSTREAM_AUTH ? { upstreamAuth: process.env.SAM_INFERENCE_UPSTREAM_AUTH } : {}),
    requiredCapability: capability,
    onLog: log,
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve()) })
  log(`gated proxy on http://${host}:${port} -> ${target} (${capability ? 'capability gate ON' : 'GATE OFF — allowed explicitly'})`)
  let stopAnnounce: (() => void) | undefined
  const announceName = flag('--announce-name')
  if (announceName) {
    const { SamClient } = await import('../core/index.js')
    const sam = new SamClient()
    const register = async (body: unknown): Promise<void> => {
      const res = await sam.requestRaw('/sam/service/register', { method: 'POST', body })
      if (res.status < 200 || res.status >= 300) throw new Error(`register failed (${res.status})`)
    }
    stopAnnounce = startAnnounceLoop({ register, name: announceName, targetUrl: `http://${host}:${port}`, onLog: log })
    log(`announcing as ${announceName} (re-announces every 30s; survives node restarts)`)
  }
  const shutdown = (): void => { stopAnnounce?.(); server.close(() => exit(0)); setTimeout(() => exit(0), 2000).unref() }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

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
    case 'binary': {
      // Every usable sam-node on this machine; ★ marks the kit's suggestion
      // (bundled — version-pinned to the kit and integrity-checked). Pin a
      // different one with SAM_NODE=<path>.
      const options = await nodes.binaryOptions()
      if (options.length === 0) { stderr.write(`No sam-node found anywhere — install one with: sam-mesh node install\n`); exit(1) }
      for (const o of options) {
        stdout.write(`${o.suggested ? '★' : ' '} ${o.path}  [${o.source}${o.tag ? ` ${o.tag}` : ''}]${o.suggested ? ' — suggested' : ''}\n`)
      }
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
    case 'reset': {
      // Deliberate terminal operation: clear the stored identity (PeerID
      // kept) so `node join` can re-enroll — the half-enrolled state a
      // failed --jwt-path join leaves behind refuses a plain join.
      const stopped = await nodes.stop()
      if (!stopped.ok) { stderr.write(`could not stop the node: ${stopped.error}\n`); exit(1) }
      const reset = await nodes.resetIdentity()
      print(reset)
      if (!reset.ok) exit(1)
      return
    }
    case 'recover': {
      const recovery = await manager().recoverStaleIdentity()
      if (recovery.recovered) {
        print({ ok: true, message: 'identity self-healed via stored refresh token — node re-enrolled and started' })
      } else {
        print({ ok: false, error: `automatic re-enrollment failed (${recovery.reason}) — re-enroll: sam-mesh node join` })
        exit(1)
      }
      return
    }
    case 'join': {
      let controlPlane = process.env.SAM_CONTROL_PLANE ?? DEFAULT_CONTROL_PLANE
      const flagIndex = rest.indexOf('--control-plane')
      if (flagIndex >= 0 && rest[flagIndex + 1]) controlPlane = rest[flagIndex + 1]!
      const tokenIndex = rest.indexOf('--bootstrap-token-path')
      const bootstrapTokenPath = tokenIndex >= 0 ? rest[tokenIndex + 1] : undefined
      const status = await nodes.status()
      const step = nextJoinStep(status, interactive(), controlPlane)
      if (step.action === 'already-enrolled') { stderr.write(`This node already has an identity in ${step.dataDir ?? status.dataDir} (reset stays a deliberate terminal operation).\n`); exit(2) }
      if (step.action === 'switch-mesh') {
        if (!interactive()) { stderr.write(`Enrolled on ${step.from} but joining ${step.to} — switching meshes needs an interactive terminal.\n`); exit(2) }
        if (!(await confirm(`This node is enrolled on ${step.from}. Switch to ${step.to}? The stored identity is replaced (PeerID kept).`))) {
          stderr.write('Aborted — staying on the current mesh.\n'); exit(2)
        }
        const stopped = await nodes.stop()
        if (!stopped.ok) { stderr.write(`could not stop the node: ${stopped.error}\n`); exit(1) }
        const reset = await nodes.resetIdentity()
        if (!reset.ok) { stderr.write(`could not reset the identity: ${reset.error}\n`); exit(1) }
        stderr.write('Identity cleared (PeerID kept) — joining the new mesh.\n')
      }
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
      // The public hub's device flow is flaky in one specific way: the token
      // poll can die on a bare 401 (no OAuth error body — upstream surfaces
      // it verbatim) before/around approval. Every observed case succeeds on
      // a fresh code, so retry that failure class exactly once.
      const transient = (error: string | null | undefined): boolean =>
        error != null && /token request failed with status: 401|request was aborted/i.test(error)
      let session = nodes.beginEnrollment({ controlPlane, ...(bootstrapToken !== undefined ? { bootstrapToken } : {}) })
      let sessionStarted = Date.now()
      for (let attempt = 1; ; attempt++) {
        sessionStarted = Date.now()
        stderr.write(`Enrollment session ${session.sessionId} — waiting for the device flow...\n`)
        while (session.state === 'starting') await new Promise((r) => setTimeout(r, 200))
        if (session.state === 'awaiting_user') {
          stdout.write(`\nOpen this URL in a browser:\n\n  ${session.verificationUrl}\n\nEnter code: ${session.userCode}\n\nWaiting for authorization...\n`)
        }
        process.once('SIGINT', () => { session.cancel(); stderr.write('\nEnrollment cancelled.\n') })
        await session.done
        // Retry only when the session survived a while — i.e. polling worked
        // and something later broke. An instant 401 is deterministic (e.g.
        // sam-node ≤ alpha.7 cannot poll dex at all); a retry would burn a
        // fresh code on the same wall.
        if (attempt === 1 && session.state === 'failed' && transient(session.error) && Date.now() - sessionStarted >= 45_000) {
          stderr.write(`Device flow hiccup (${session.error}) — retrying once with a fresh code.\n`)
          session = nodes.beginEnrollment({ controlPlane, ...(bootstrapToken !== undefined ? { bootstrapToken } : {}) })
          continue
        }
        if (session.state === 'failed' && transient(session.error) && Date.now() - sessionStarted < 45_000) {
          stderr.write(`The device flow failed INSTANTLY — this sam-node build cannot poll the hub's identity provider (known: every release ≤ alpha.7 dies on dex's 401-pending; fixed at upstream HEAD). Enroll with a newer sam-node (SAM_NODE=/path/to/sam-node) or wait for the next upstream release.\n`)
        }
        break
      }
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
      stderr.write('Usage: sam-mesh node <status|install|start|stop|join|recover|reset> [--control-plane <url>] [--bootstrap-token-path <file>]\n')
      exit(2)
  }
}

const [, , command, ...rest] = argv
if (!command || command === '--help' || command === '-h') {
  stdout.write(`Usage: sam-mesh <status|peers|services|tools|models|call|tail|node|token|fleet|doctor|skill> [args]

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

Serve inference on the mesh:
  runtime status|models           vendored llama.cpp + local model store
  runtime pull '<repo:quant>'     download a GGUF into the store (explicit, network)
  inference-proxy --target <url> [--port 4100] [--announce-name <n>]
                          loopback gate proxy: models listing open, execution
                          requires the fleet capability (env SAM_INFERENCE_CAPABILITY,
                          upstream bearer env SAM_INFERENCE_UPSTREAM_AUTH).
                          Refuses to run ungated without --allow-ungated.
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
  let runtimeTag: string | null | undefined
  let modelStore: { count: number; bytes: number } | undefined
  let serveRows: Array<{ name: string; state: string; detail?: string | undefined; mode?: 'runtime' | 'external' | undefined }> | undefined
  try {
    const { resolveVendoredLlama, listModelStore, readServeStatuses } = await import('../node/index.js')
    const dataDir = process.env.SAM_DATA_DIR ?? `${process.env.HOME}/.config/sam-mesh`
    try { runtimeTag = (await resolveVendoredLlama(dataDir)).tag } catch { runtimeTag = null }
    const models = await listModelStore(dataDir)
    modelStore = { count: models.length, bytes: models.reduce((a, m) => a + m.bytes, 0) }
    serveRows = (await readServeStatuses(dataDir)).map(s => ({ name: s.name, state: s.state, detail: s.detail }))
  } catch { runtimeTag = undefined }
  // Chat posture (when dsh-mesh-chat is present): inboxes visible through
  // discovery, and the fleet channel probed with the stored capability.
  let chat: { inboxVisible?: number | undefined; channel?: 'ok' | 'unavailable' | 'unpaired' | undefined } | null = null
  try {
    if (sam === undefined) throw new Error('daemon down')
    const remoteInboxes = await sam.discoverRemoteServices({ type: 'mcp', name: 'dsh-chat-inbox' }).catch(() => [])
    // Own services are not self-listed — the local registry answers that half.
    const localServices = await sam.listLocalServices().catch(() => [] as Array<{ name?: string }>)
    const localInbox = localServices.some(s => (s as { name?: string }).name === 'dsh-chat-inbox') ? 1 : 0
    chat = { inboxVisible: remoteInboxes.length + localInbox }
    const capPath = `${process.env.HOME}/.config/sam-mesh/fleet-capability`
    const capability = existsSync(capPath) ? (await readFile(capPath, 'utf8')).trim() : ''
    // Probe EVERY visible task service with the stored capability — it works
    // for the fleet(s) we belong to and fails for the rest (their operators).
    const fleets = await sam.discoverRemoteServices({ type: 'mcp', name: 'dsh-task-service' }).catch(() => [])
    const hostsLocal = localServices.some(s => (s as { name?: string }).name?.includes('task-service'))
    if (fleets.length > 0 || hostsLocal) {
      const verdicts: string[] = []
      for (const fleet of fleets) {
        if (!fleet.peer_id) continue
        try {
          await sam.callRemoteTool({ peer_id: fleet.peer_id, tool_name: `mcp://${fleet.srv_name ?? 'dsh-task-service'}/chat_fetch`, arguments: { limit: 1, _capability: capability } })
          verdicts.push('ok')
        } catch (error) {
          verdicts.push(/capability/i.test(error instanceof Error ? error.message : String(error)) ? 'denied' : 'error')
        }
      }
      if (verdicts.includes('ok')) chat.channel = 'ok'
      else if (hostsLocal && capability) chat.channel = 'ok' // we host the fleet and hold its credential — the channel is ours
      else if (hostsLocal) chat.channel = 'unpaired'
      else if (verdicts.includes('error')) chat.channel = 'unavailable'
      else chat.channel = 'unpaired'
    }
  } catch { chat = null }
  const checks = buildChecks({
    installed: status.installed, enrolled: status.enrolled, running: status.running,
    peerCount, serviceCount, localServiceCount, runtimeTag, modelStore, serveRows, chat,
  })
  if (status.enrolled && status.enrolledHub) {
    const enrolledCheck = checks.find(ch => ch.name === 'enrolled on a hub')
    if (enrolledCheck) enrolledCheck.detail = status.enrolledHub
  }
  if (status.installed && status.binarySource) {
    const binaryCheck = checks.find(ch => ch.name === 'sam-node binary')
    if (binaryCheck) binaryCheck.detail = status.binarySource === 'bundled' ? 'carried by the package' : `${status.binarySource}: ${status.binaryPath}`
  }
  stdout.write(renderDoctor(checks) + '\n')
}
else if (command === 'fleet') await runFleet(rest)
else if (command === 'skill') stdout.write(AGENT_SKILL + '\n')
else if (command === 'node') await runNode(rest)
else if (command === 'runtime') await runRuntime(rest)
else if (command === 'inference-proxy') await runInferenceProxy(rest)
else if (CLIENT_COMMANDS.has(command)) await runClient([command, ...rest])
else { stderr.write(`Unknown command: ${command}\n`); exit(2) }
