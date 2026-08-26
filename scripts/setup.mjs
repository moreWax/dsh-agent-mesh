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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

function findHarness() {
  const candidates = [
    process.env.DSH_CHECKOUT,
    join(dirname(ROOT), 'deepseek-harness'),   // sibling checkout (README layout)
    join(homedir(), 'deepseek-harness'),
    join(homedir(), 'ds', 'deepseek-harness'),
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, HARNESS_CLI))) return dir
  }
  return null
}

async function ask(rl, question, fallbackYes = true) {
  const answer = (await rl.question(`${question}${fallbackYes ? ' (Y/n) ' : ' (y/N) '}`)).trim().toLowerCase()
  return answer === '' ? fallbackYes : answer === 'y' || answer === 'yes'
}

const manual = (harness) => {
  say()
  say('Manual steps:')
  if (!harness) {
    say(`  git clone ${HARNESS_REPO} && cd deepseek-harness`)
    say('  corepack enable && pnpm install && pnpm -r build && cd ..')
  }
  say('  pnpm install && pnpm fetch:binaries && pnpm -r build')
  say(`  node --import tsx/esm ${harness ? join(harness, HARNESS_CLI) : '<deepseek-harness>/' + HARNESS_CLI} plugin --profile web add link:${join(ROOT, 'packages', 'dsh-agent-mesh')}`)
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
      say(`DeepSeek Harness found at ${harness}`)
    } else {
      say('DeepSeek Harness not found on this machine.')
      say('The dsh-agent-mesh plugin runs INSIDE the harness, so it is required.')
      if (await ask(rl, `Download and build it now into ${join(dirname(ROOT), 'deepseek-harness')}?`)) {
        run('git', ['clone', HARNESS_REPO], dirname(ROOT))
        harness = join(dirname(ROOT), 'deepseek-harness')
        run('corepack', ['enable'], harness)
        run('pnpm', ['install'], harness)
        run('pnpm', ['-r', 'build'], harness)
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
      run('node', ['--import', 'tsx/esm', join(harness, HARNESS_CLI), 'plugin', '--profile', 'web', 'add', `link:${join(ROOT, 'packages', 'dsh-agent-mesh')}`], ROOT)
      say()
      say('Done. Start the Web UI and open Settings → Agent Mesh:')
      say(`  cd ${harness}`)
      say('  node --import tsx/esm apps/cli/src/bin.ts --profile web --port 3080')
      say('Enroll, discover fleets, join, approve — all in the card from here.')
    } else {
      manual(harness)
    }
  } finally { rl.close() }
}

main().catch((error) => { process.stderr.write(`setup failed: ${error.message}\n`); process.exit(1) })
