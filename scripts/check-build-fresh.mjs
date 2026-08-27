#!/usr/bin/env node
/**
 * check-build-fresh — refuse to run against a stale build. A git pull that
 * changes src/ without a rebuild used to crash-loop dsh with inscrutable
 * loader errors; now the failure names the fix. Exit 0 = fresh, 1 = stale.
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['packages/sam-mesh', 'packages/dsh-agent-mesh']

const newest = (dir, skip = () => false) => {
  let best = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!skip(p)) best = Math.max(best, statSync(p).mtimeMs)
    }
  }
  try { walk(dir) } catch { /* missing dir */ }
  return best
}

const stale = []
for (const pkg of PACKAGES) {
  const src = join(ROOT, pkg, 'src')
  const lib = join(ROOT, pkg, 'lib')
  if (!existsSync(src)) continue
  if (!existsSync(lib)) { stale.push(`${pkg}: no lib/ at all`); continue }
  const srcT = newest(src)
  const libT = newest(lib)
  if (srcT > libT) stale.push(`${pkg}: src is newer than lib`)
}
if (stale.length > 0) {
  process.stderr.write(`STALE BUILD — run pnpm -r build first:\n  ${stale.join('\n  ')}\n`)
  process.exit(1)
}
process.stdout.write('build is fresh\n')
