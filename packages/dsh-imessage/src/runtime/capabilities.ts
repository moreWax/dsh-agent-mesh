import { access, readFile, statfs } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import type { RuntimeCheck } from './interface.js'

export interface CapabilityOptions { homeDir: string; procDir?: string; minimumBytes?: number; minimumMemoryBytes?: number; read?: typeof readFile; filesystem?: typeof statfs }
async function text(path: string, read: typeof readFile): Promise<string | undefined> { try { return String(await read(path, 'utf8')).trim() } catch { return undefined } }

export async function detectRootlessCapabilities(options: CapabilityOptions): Promise<RuntimeCheck[]> {
  const proc = options.procDir ?? '/proc'; const read = options.read ?? readFile; const checks: RuntimeCheck[] = []
  const userns = await text(join(proc, 'sys/kernel/unprivileged_userns_clone'), read)
  checks.push({ name: 'user-namespaces', ok: userns === undefined || userns === '1', required: true, detail: userns === '0' ? 'disabled' : 'available', ...(userns === '0' ? { fix: 'Enable unprivileged user namespaces through your OS administrator, or use an existing cluster' } : {}) })
  const apparmorRestriction = await text(join(proc, 'sys/kernel/apparmor_restrict_unprivileged_userns'), read)
  checks.push({ name: 'apparmor-userns', ok: apparmorRestriction !== '1', required: true, detail: apparmorRestriction === '1' ? 'unprivileged user namespaces are restricted by AppArmor' : 'not restricted', ...(apparmorRestriction === '1' ? { fix: 'Ask the OS administrator to permit the pinned k3s rootless binary through an AppArmor profile, or use an existing cluster/external Matrix' } : {}) })
  const max = Number(await text(join(proc, 'sys/user/max_user_namespaces'), read) ?? '1')
  checks.push({ name: 'user-namespace-limit', ok: max > 0, required: true, detail: max > 0 ? String(max) : 'zero', ...(max > 0 ? {} : { fix: 'Increase user.max_user_namespaces or use external Matrix' }) })
  const cgroup = await text(join(proc, 'filesystems'), read)
  const cgroup2 = Boolean(cgroup?.includes('cgroup2'))
  checks.push({ name: 'cgroup-v2', ok: cgroup2, required: true, detail: cgroup2 ? 'supported' : 'not detected', ...(cgroup2 ? {} : { fix: 'Boot with cgroup v2 enabled or use an existing cluster' }) })
  const meminfo = await text(join(proc, 'meminfo'), read); const kb = Number(meminfo?.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? meminfo?.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0); const requiredMem = options.minimumMemoryBytes ?? 2 * 1024 ** 3; const memoryOk = kb * 1024 >= requiredMem
  checks.push({ name: 'memory', ok: memoryOk, required: true, detail: `${Math.floor(kb / 1024)} MiB available`, ...(memoryOk ? {} : { fix: `Provide at least ${Math.ceil(requiredMem / 1024 ** 3)} GiB memory` }) })
  try { let target = options.homeDir; let fs: Awaited<ReturnType<typeof statfs>>; while (true) { try { fs = await (options.filesystem ?? statfs)(target); break } catch { const parent = dirname(target); if (parent === target) throw new Error('no existing parent filesystem'); target = parent } }; const available = Number(fs.bavail) * Number(fs.bsize); const minimum = options.minimumBytes ?? 8 * 1024 ** 3; checks.push({ name: 'disk-space', ok: available >= minimum, required: true, detail: `${Math.floor(available / 1024 ** 3)} GiB available`, ...(available >= minimum ? {} : { fix: `Free at least ${Math.ceil(minimum / 1024 ** 3)} GiB in the runtime filesystem` }) }) }
  catch { checks.push({ name: 'disk-space', ok: false, required: true, detail: 'could not inspect', fix: 'Choose a writable local runtime directory' }) }
  for (const device of ['/dev/net/tun']) { try { await access(device, constants.R_OK | constants.W_OK); checks.push({ name: 'tun', ok: true, required: false, detail: 'available' }) } catch { checks.push({ name: 'tun', ok: true, required: false, detail: 'not available; slirp4netns userspace networking will be used' }) } }
  return checks
}
