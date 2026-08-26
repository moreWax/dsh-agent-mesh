#!/usr/bin/env node
/**
 * pnpm start — the update loop as one command:
 *
 *   1. build this workspace (picks up a git pull)
 *   2. locate the harness (shared discovery); if its web bundle is missing,
 *      build it first with the repo orchestrator (libs before the web app)
 *   3. launch the Web UI in the foreground — the dsh CLI opens the browser
 *      itself; Ctrl+C stops the server
 *
 * --dry-run prints the launch command without starting anything.
 */
import { spawnSync } from 'node:child_process'
import { findHarness, harnessBuilt, harnessCwd, launchArgs, ROOT } from './harness.mjs'

const say = (line = '') => process.stdout.write(`${line}\n`)
const run = (cmd, args, cwd) => {
  say(`+ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`)
}

const harness = findHarness()
if (!harness) {
  process.stderr.write('No DeepSeek Harness found on this machine — run: pnpm setup\n')
  process.exit(1)
}
say(harness.kind === 'bin' ? 'Harness: dsh on PATH' : `Harness: ${harness.dir}`)

run('pnpm', ['-r', 'build'], ROOT)

if (harness.kind === 'checkout' && !harnessBuilt(harness.dir)) {
  say('Harness web bundle missing — building the harness first (pnpm build).')
  run('pnpm', ['build'], harness.dir)
}

const [cmd, ...args] = launchArgs(harness)
if (process.argv.includes('--dry-run')) {
  say(`Would launch (cwd ${harnessCwd(harness)}): ${cmd} ${args.join(' ')}`)
} else {
  say()
  say('Starting the Web UI — the browser opens on its own. Settings → Agent Mesh. Ctrl+C stops.')
  spawnSync(cmd, args, { cwd: harnessCwd(harness), stdio: 'inherit' })
}
