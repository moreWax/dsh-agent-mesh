#!/usr/bin/env node
/**
 * Interactive from-source setup. One command after cloning:
 *
 *   pnpm setup
 *
 * Walks the whole flow with an explicit y/N before every network action
 * (consent doctrine — nothing downloads silently):
 *   1. locate a DeepSeek Harness checkout (sibling, ~, or $DSH_CHECKOUT) —
 *      if none, OFFER to clone + build it
 *   2. pnpm install for this workspace
 *   3. offer the vendored sam-node binaries (fetch:binaries)
 *   4. build the workspace
 *   5. offer to register the plugin with the harness web profile
 *
 * Non-TTY (CI, scripts): prints the manual steps and exits — a prompt that
 * cannot be answered must never become a silent yes.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness'
const HARNESS_CLI = join('apps', 'cli', 'src', 'bin.ts')

const say = (line = '') => process.stdout.write(`${line}\n`)
const run = (cmd, args, cwd) => {
  say(`+ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`)
}

/**
 * A harness find is either a CHECKOUT (we invoke bin.ts with node+tsx) or a
 * BIN on PATH (we invoke `dsh` directly). Detection order — explicit, PATH,
 * well-known spots, then a bounded scan of common dev roots. A directory
 * only counts if it LOOKS like the harness (bin.ts + a deepseek package
 * name); the scan stays at depth 2 so it is cheap and predictable.
 */
function looksLikeHarness(dir) {
  try {
    if (!existsSync(join(dir, HARNESS_CLI))) return false
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return /deepseek|harness/i.test(String(pkg.name ?? ''))
  } catch { return false }
}

function findHarnessBin() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, 'dsh'))) return 'dsh'
  }
  return null
}

function findHarness() {
  if (process.env.DSH_CHECKOUT && looksLikeHarness(process.env.DSH_CHECKOUT)) {
    return { kind: 'checkout', dir: resolve(process.env.DSH_CHECKOUT) }
  }
  const bin = findHarnessBin()
  if (bin) return { kind: 'bin', bin }
  const home = homedir()
  const direct = [
    join(dirname(ROOT), 'deepseek-harness'),   // sibling checkout (README layout)
    join(home, 'deepseek-harness'),
    join(home, 'ds', 'deepseek-harness'),
  ]
  for (const dir of direct) if (looksLikeHarness(dir)) return { kind: 'checkout', dir }
  // Bounded scan: any checkout-shaped directory (whatever its name) one or
  // two levels under the usual development roots.
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

async function ask(rl, question, fallbackYes = true) {
  const answer = (await rl.question(`${question}${fallbackYes ? ' (Y/n) ' : ' (y/N) '}`)).trim().toLowerCase()
  return answer === '' ? fallbackYes : answer === 'y' || answer === 'yes'
}

const cliPrefix = (harness) =>
  harness?.kind === 'bin' ? ['dsh'] : ['node', '--import', 'tsx/esm', harness ? join(harness.dir, HARNESS_CLI) : `<deepseek-harness>/${HARNESS_CLI}`]

const manual = (harness) => {
  say()
  say('Manual steps:')
  if (!harness) {
    say(`  git clone ${HARNESS_REPO} && cd deepseek-harness`)
    say('  corepack enable && pnpm install && pnpm build && cd ..')   // pnpm build = the repo's own orchestrator (libs BEFORE the web app; pnpm -r build races cyclic workspace deps)
  }
  say('  pnpm install && pnpm fetch:binaries && pnpm -r build')
  say(`  ${[...cliPrefix(harness), 'plugin', '--profile', 'web', 'add', `link:${join(ROOT, 'packages', 'dsh-agent-mesh')}`].join(' ')}`)
}

async function main() {
  if (!process.stdin.isTTY) {
    say('Non-interactive shell detected — no prompts, no downloads.')
    manual(findHarness())
    return
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    // 1. the harness — the plugin's host
    let harness = findHarness()
    if (harness) {
      say(harness.kind === 'bin' ? 'DeepSeek Harness found on PATH (dsh)' : `DeepSeek Harness found at ${harness.dir}`)
      // A checkout whose web bundle is missing is a checkout that was never
      // built (or whose build failed mid-way — a previous setup run, say).
      // Offer to finish it rather than sailing into a broken Web UI later.
      if (harness.kind === 'checkout' && !existsSync(join(harness.dir, 'apps', 'web', 'dist'))) {
        say('…but its build artifacts are missing (apps/web/dist) — it was never built or the build failed.')
        if (await ask(rl, 'Build the harness now? (pnpm build — the repo orchestrator builds libs before the web app)')) {
          run('pnpm', ['build'], harness.dir)
        }
      }
    } else {
      say('DeepSeek Harness not found on this machine.')
      say('The dsh-agent-mesh plugin runs INSIDE the harness, so it is required.')
      if (await ask(rl, `Download and build it now into ${join(dirname(ROOT), 'deepseek-harness')}?`)) {
        run('git', ['clone', HARNESS_REPO], dirname(ROOT))
        harness = { kind: 'checkout', dir: join(dirname(ROOT), 'deepseek-harness') }
        run('corepack', ['enable'], harness.dir)
        run('pnpm', ['install'], harness.dir)
        run('pnpm', ['build'], harness.dir)   // NOT pnpm -r build — see below
      } else {
        say('Skipping the harness download. The plugin builds fine, but needs dsh to run.')
        manual(null)
      }
    }

    // 2-4. this workspace
    run('pnpm', ['install'], ROOT)
    if (await ask(rl, 'Vendor the sam-node binaries now (~13MB for your platform, official release, checksum-verified)?')) {
      run('pnpm', ['fetch:binaries'], ROOT)
    } else {
      say('Skipped — the node manager falls back to a sam-node already on PATH.')
    }
    run('pnpm', ['-r', 'build'], ROOT)

    // 5. register the plugin
    if (harness && await ask(rl, 'Register the plugin with the dsh web profile now?')) {
      const [cmd, ...args] = [...cliPrefix(harness), 'plugin', '--profile', 'web', 'add', `link:${join(ROOT, 'packages', 'dsh-agent-mesh')}`]
      run(cmd, args, ROOT)
      say()
      say('Done. Start the Web UI and open Settings → Agent Mesh:')
      if (harness.kind === 'bin') {
        say('  dsh --profile web --port 3080')
      } else {
        say(`  cd ${harness.dir}`)
        say('  node --import tsx/esm apps/cli/src/bin.ts --profile web --port 3080')
      }
      say('Enroll, discover fleets, join, approve — all in the card from here.')
    } else {
      manual(harness)
    }
  } finally { rl.close() }
}

main().catch((error) => { process.stderr.write(`setup failed: ${error.message}\n`); process.exit(1) })
