/**
 * Shared DeepSeek Harness discovery for the repo scripts (setup.mjs,
 * start.mjs). One implementation, no drift.
 *
 * A find is either a CHECKOUT (invoke bin.ts with node+tsx from its
 * directory) or a BIN on PATH (invoke `dsh` directly). Detection order:
 * explicit env, PATH, well-known spots, then a bounded depth-2 scan of
 * common dev roots — a directory only counts if it LOOKS like the harness
 * (bin.ts + a deepseek package name).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness'
export const HARNESS_CLI = join('apps', 'cli', 'src', 'bin.ts')
export const PLUGIN_DIR = join(ROOT, 'packages', 'dsh-agent-mesh')

export function looksLikeHarness(dir) {
  try {
    if (!existsSync(join(dir, HARNESS_CLI))) return false
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return /deepseek|harness/i.test(String(pkg.name ?? ''))
  } catch { return false }
}

export function findHarness() {
  if (process.env.DSH_CHECKOUT && looksLikeHarness(process.env.DSH_CHECKOUT)) {
    return { kind: 'checkout', dir: resolve(process.env.DSH_CHECKOUT) }
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'dsh'))) return { kind: 'bin', bin: 'dsh' }
  }
  const home = homedir()
  const direct = [
    join(dirname(ROOT), 'deepseek-harness'),
    join(home, 'deepseek-harness'),
    join(home, 'ds', 'deepseek-harness'),
  ]
  for (const dir of direct) if (looksLikeHarness(dir)) return { kind: 'checkout', dir }
  const roots = ['code', 'dev', 'src', 'projects', 'work', 'repos', 'git', 'Developer', 'ds']
    .map(r => join(home, r)).filter(d => existsSync(d))
  for (const root of roots) {
    let children = []
    try { children = readdirSync(root, { withFileTypes: true }) } catch { continue }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const dir = join(root, child.name)
      if (looksLikeHarness(dir)) return { kind: 'checkout', dir }
      let grandchildren = []
      try { grandchildren = readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const grand of grandchildren) {
        if (!grand.isDirectory()) continue
        const nested = join(dir, grand.name)
        if (looksLikeHarness(nested)) return { kind: 'checkout', dir: nested }
      }
    }
  }
  return null
}

/** The harness web bundle's presence marker: a checkout that was never (or never finished) building lacks it. */
export function harnessBuilt(dir) {
  return existsSync(join(dir, 'apps', 'web', 'dist'))
}

/** The plugin registration command (argv) for a found harness. */
export function registerArgs(harness) {
  const cli = harness.kind === 'bin' ? ['dsh'] : ['node', '--import', 'tsx/esm', join(harness.dir, HARNESS_CLI)]
  return [...cli, 'plugin', '--profile', 'web', 'add', `link:${PLUGIN_DIR}`]
}

/** The Web UI launch command (argv) for a found harness. */
export function launchArgs(harness) {
  return harness.kind === 'bin'
    ? ['dsh', '--profile', 'web', '--port', '3080']
    : ['node', '--import', 'tsx/esm', join(harness.dir, HARNESS_CLI), '--profile', 'web', '--port', '3080']
}

/** cwd that makes tsx resolve: the harness checkout (tsx is its devDependency). */
export function harnessCwd(harness) {
  return harness.kind === 'checkout' ? harness.dir : ROOT
}
