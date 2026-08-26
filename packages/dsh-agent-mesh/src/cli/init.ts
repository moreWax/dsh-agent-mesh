import { access, chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createConnection } from "node:net"

export interface InitOptions { profile?: string; yes?: boolean; start?: boolean; join?: boolean; skill?: boolean; patch?: boolean; samNode?: string; dshHome?: string; timeoutMs?: number }
export interface InitIO { out(line: string): void; err(line: string): void; approve(question: string): Promise<boolean> }
export interface Check { name: string; ok: boolean; detail: string }
export interface InitResult { checks: readonly Check[]; changed: readonly string[]; planned: readonly string[] }

const PATCH_MARKER = "# dsh-agent-mesh init (managed non-sensitive configuration)"
const PATCH = `${PATCH_MARKER}\n- insert:\n    - id: agent-mesh\n      name: '@morewax/dsh-agent-mesh'\n      config:\n        socketPath: ~/.config/sam-mesh/sam.sock\n        tcpUrl: http://127.0.0.1:8080\n        preferSocket: true\n- insert:\n    - id: agent-mesh-llm\n      name: '@morewax/dsh-agent-mesh/llm'\n      config:\n        socketPath: ~/.config/sam-mesh/sam.sock\n        tcpUrl: http://127.0.0.1:8080\n        preferSocket: true\n        route: { mode: auto }\n- insert:\n    - id: agent-mesh-tools\n      name: '@morewax/dsh-agent-mesh/providers/tools'\n      config:\n        requiredLabelsAnyOf: []\n        refreshIntervalMs: 60000\n        failOnStartupError: false\n`

async function exists(path: string): Promise<boolean> { try { await access(path, constants.F_OK); return true } catch { return false } }
async function atomicWrite(path: string, data: string, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true }); const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  const handle = await open(tmp, "wx", mode); try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
  await rename(tmp, path); if (mode !== undefined) await chmod(path, mode)
}
function executable(command: string): boolean { return spawnSync(command, ["--help"], { stdio: "ignore" }).status === 0 }
async function socketAnswers(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolveResult => { const socket = createConnection(path); const timer = setTimeout(() => { socket.destroy(); resolveResult(false) }, timeoutMs); socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolveResult(true) }); socket.once("error", () => { clearTimeout(timer); resolveResult(false) }) })
}
async function httpProbe(url: string, timeoutMs: number): Promise<boolean> { try { const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); return response.status < 500 } catch { return false } }
function readIdentity(dataDir: string): Promise<boolean> { return Promise.all(["identity.json", "node.json", "credentials.json"].map(n => exists(join(dataDir, n)))).then(x => x.some(Boolean)) }

/** Patch only the managed, non-secret composition layer. Existing user text is never replaced. */
export async function patchProfile(profile: string, dshHome = join(homedir(), ".dsh")): Promise<boolean> {
  if (!/^[A-Za-z0-9_.-]+$/.test(profile)) throw new TypeError("profile contains unsafe characters")
  const path = join(resolve(dshHome), "profiles", profile, "cordis.patch.yml")
  const prior = await readFile(path, "utf8").catch(() => "[]\n")
  if (prior.includes(PATCH_MARKER)) return false
  // Replace the conventional empty document; otherwise append without parsing or losing comments/tags.
  const base = prior.trim() === "[]" || prior.trimEnd().endsWith("\n[]") ? prior.replace(/\[\]\s*$/, "") : prior
  await atomicWrite(path, `${base.trimEnd()}${base.trim() ? "\n" : ""}${PATCH}`)
  return true
}

/** Start enrollment in a detached waiter so closing npx does not kill the device flow. */
export async function startDeviceWaiter(samNode: string, stateDir: string): Promise<{ pid: number; log: string; existing?: boolean }> {
  await mkdir(stateDir, { recursive: true }); const log = join(stateDir, "device-enrollment.log"), pidPath = join(stateDir, "device-enrollment.pid")
  const prior = Number.parseInt((await readFile(pidPath, "utf8").catch(() => "" )).trim(), 10)
  if (Number.isSafeInteger(prior) && prior > 1) { try { process.kill(prior, 0); return { pid: prior, log, existing: true } } catch {} }
  const fd = await open(log, "a", 0o600)
  const child = spawn(samNode, ["--auth-mode", "device", "join"], { detached: true, stdio: ["ignore", fd.fd, fd.fd] })
  if (!child.pid) { await fd.close(); throw new Error("could not start enrollment waiter") }
  child.unref(); await atomicWrite(pidPath, `${child.pid}\n`, 0o600); await fd.close(); return { pid: child.pid, log }
}
async function runApproved(samNode: string, args: string[]): Promise<void> {
  if (args.some(a => /^(reset|purge|wipe|destroy)$/i.test(a))) throw new Error("destructive node commands cannot be run by init")
  const result = spawnSync(samNode, args, { stdio: "inherit" }); if (result.status !== 0) throw new Error(`${samNode} ${args.join(" ")} failed (${result.status ?? "signal"})`)
}

export async function init(options: InitOptions = {}, io: InitIO): Promise<InitResult> {
  const profile = options.profile ?? "default", dshHome = resolve(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh"))
  const samNode = options.samNode ?? "sam-node", timeout = options.timeoutMs ?? 1500
  const dataDir = join(homedir(), ".config", "sam-mesh"), socket = join(dataDir, "sam.sock")
  const checks: Check[] = [], changed: string[] = [], planned: string[] = []
  const binary = executable(samNode); checks.push({ name: "sam-node", ok: binary, detail: binary ? samNode : "not found or not executable" })
  const socketPresent = await exists(socket); checks.push({ name: "socket", ok: socketPresent, detail: socket })
  const enrolled = await readIdentity(dataDir); checks.push({ name: "enrollment", ok: enrolled, detail: enrolled ? "identity present" : "identity not detected" })
  const local = socketPresent && await socketAnswers(socket, timeout); checks.push({ name: "connectivity", ok: local, detail: local ? "Unix socket accepts connections" : "local API unavailable" })
  const model = local && (await httpProbe("http://127.0.0.1:8080/v1/models", timeout)); checks.push({ name: "model", ok: model, detail: model ? "model endpoint answers" : "not verified" })
  const echo = local && (await httpProbe("http://127.0.0.1:8080/health", timeout)); checks.push({ name: "harmless-echo", ok: echo, detail: echo ? "harmless local probe answered" : "not verified" })
  for (const c of checks) io.out(`${c.ok ? "✓" : "·"} ${c.name}: ${c.detail}`)
  if (!binary) { io.err("Install sam-node first. init made no node-state changes."); return { checks, changed, planned } }
  const stateDir = join(dshHome, "state", "agent-mesh")
  if (!enrolled && options.join) {
    planned.push(`${samNode} --auth-mode device join`)
    if (options.yes || await io.approve("Start persistent device enrollment waiter?")) { const w = await startDeviceWaiter(samNode, stateDir); if (!w.existing) changed.push(`device waiter pid ${w.pid}`); io.out(`${w.existing ? "Enrollment waiter is already running" : "Enrollment continues"} in ${w.log}`) }
  }
  if (!local && options.start) {
    planned.push(`${samNode} run --daemonize`)
    if (options.yes || await io.approve("Start sam-node daemon?")) { await runApproved(samNode, ["run", "--daemonize"]); changed.push("sam-node daemon started") }
  }
  if (options.skill !== false) {
    const skillRoot = join(dshHome, "skills"); planned.push(`${samNode} skill install --dir ${skillRoot}`)
    if (options.yes || await io.approve(`Install/update the SAM skill in ${skillRoot}?`)) { await mkdir(skillRoot, { recursive: true }); await runApproved(samNode, ["skill", "install", "--dir", skillRoot]); changed.push(skillRoot) }
  }
  if (options.patch !== false) {
    const patchPath = join(dshHome, "profiles", profile, "cordis.patch.yml"); planned.push(`patch ${patchPath}`)
    if (options.yes || await io.approve(`Patch DSH profile ${profile} (non-secret atomic edit)?`)) if (await patchProfile(profile, dshHome)) changed.push(patchPath)
  }
  return { checks, changed, planned }
}
