#!/usr/bin/env node
import { createInterface } from "node:readline/promises"
import { stdin, stdout, stderr } from "node:process"
import { init } from "./init.js"
import { runClient } from "./client.js"

function usage(): never { console.log(`Usage: dsh-agent-mesh <init|status|services|tools|models|call> [options]\n\nOptions:\n  --profile <name>  DSH profile (default: default)\n  --yes             approve requested non-destructive writes/actions\n  --start           plan and, with approval, start sam-node --daemonize\n  --join            plan and, with approval, start persistent device enrollment\n  --no-skill        do not install the SAM skill into DSH's visible skill root\n  --no-patch        do not atomically patch the profile\n\nInit is idempotent and never resets node identity. Destructive operations are not supported.`); process.exit(0) }
const args = process.argv.slice(2)
if (args.length === 0 || args.includes("--help") || args.includes("-h")) usage()
const command = args.shift()
if (command && command !== "init") {
  // Standalone mesh client subcommands: no dsh required, talks to the local sam-node.
  await runClient([command, ...args])
  process.exit(0)
}
if (command !== "init") { console.error(`Unknown command: ${command}`); process.exit(2) }
let profile = "default", yes = false, start = false, join = false, skill = true, patch = true
for (let i=0;i<args.length;i++) { const arg=args[i]; if(arg==="--profile") { const value=args[++i]; if(!value) throw new Error("--profile requires a value"); profile=value } else if(arg==="--yes") yes=true; else if(arg==="--start") start=true; else if(arg==="--join") join=true; else if(arg==="--no-skill") skill=false; else if(arg==="--no-patch") patch=false; else throw new Error(`Unknown option: ${arg}`) }
const rl = createInterface({ input: stdin, output: stdout })
try {
 const result = await init({ profile, yes, start, join, skill, patch }, { out: line=>stdout.write(`${line}\n`), err: line=>stderr.write(`${line}\n`), approve: async q => { if (!stdin.isTTY) return false; return /^y(es)?$/i.test((await rl.question(`${q} [y/N] `)).trim()) } })
 stdout.write(`Checkup complete: ${result.changed.length ? `changed ${result.changed.length} item(s)` : "no changes"}.\n`)
} finally { rl.close() }
