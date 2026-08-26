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
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { findHarness, harnessBuilt, launchArgs, registerArgs, harnessCwd, HARNESS_CLI, HARNESS_REPO, ROOT, PLUGIN_DIR } from './harness.mjs'


const say = (line = '') => process.stdout.write(`${line}\n`)
const run = (cmd, args, cwd) => {
  say(`+ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`)
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
  if (harness?.kind === 'checkout') say(`  cd ${harness.dir}   # tsx resolves from the harness's node_modules — run the next command from here`)
  say(`  ${[...cliPrefix(harness), 'plugin', '--profile', 'web', 'add', `link:${PLUGIN_DIR}`].join(' ')}`)
  say('  — then any time: pnpm start (rebuild + launch, browser opens itself)')
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
      if (harness.kind === 'checkout' && !harnessBuilt(harness.dir)) {
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
      const [cmd, ...args] = registerArgs(harness)
      // cwd MUST be the harness checkout: --import tsx/esm resolves tsx from
      // the current directory's node_modules, and tsx is the harness's
      // devDependency, not ours. (The link path stays absolute.)
      run(cmd, args, harnessCwd(harness))
      say()
      say('Done. Start the Web UI and open Settings → Agent Mesh:')
      if (harness.kind === 'bin') {
        say('  dsh --profile web --port 3080')
      } else {
        say(`  cd ${harness.dir}`)
        say('  node --import tsx/esm apps/cli/src/bin.ts --profile web --port 3080')
      }
      say('Enroll, discover fleets, join, approve — all in the card from here.')
      // Finish INSIDE the running product, like the harness's own installer:
      // one Enter launches the Web UI in the foreground; the dsh CLI opens
      // the browser itself (its --no-open flag exists to suppress exactly
      // this). Ctrl+C stops the server and lands you back at your shell.
      if (await ask(rl, 'Start the Web UI now? (Ctrl+C stops it)')) {
        const [scmd, ...sargs] = launchArgs(harness)
        say()
        say('Starting the Web UI — the browser opens on its own. Go to Settings → Agent Mesh.')
        spawnSync(scmd, sargs, { cwd: harnessCwd(harness), stdio: 'inherit' })
        say()
        say('Web UI stopped. To start it again:')
        if (harness.kind === 'bin') say('  dsh --profile web --port 3080')
        else { say(`  cd ${harness.dir}`); say('  node --import tsx/esm apps/cli/src/bin.ts --profile web --port 3080') }
      }
    } else {
      manual(harness)
    }
  } finally { rl.close() }
}

main().catch((error) => { process.stderr.write(`setup failed: ${error.message}\n`); process.exit(1) })
