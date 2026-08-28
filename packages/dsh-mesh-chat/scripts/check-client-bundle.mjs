#!/usr/bin/env node
/**
 * Post-build contract check for lib/client.js — the artifact the dsh
 * client-module registry serves at /plugins/@morewax/dsh-mesh-chat/client.js.
 * The browser module table answers ONLY the platform baseline specifiers;
 * any other require() is a guaranteed boot-time throw in the UI. This class
 * of bug fails SILENTLY at bundle time (the registry simply drops the plugin
 * from the boot graph), so the build asserts it loudly here.
 */
import { readFileSync } from 'node:fs'

const BASELINE = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const failures = []
if (!bundle.startsWith('window.__ModuleLoader__.load({ id: "@morewax/dsh-mesh-chat"')) {
  failures.push('missing the window.__ModuleLoader__.load registration banner')
}
for (const match of bundle.matchAll(/require\("([^"]+)"\)/g)) {
  if (!BASELINE.has(match[1])) failures.push(`require("${match[1]}") — not a baseline module-table specifier; inline it or declare a module request`)
}
if (failures.length > 0) {
  process.stderr.write(`client bundle contract violated:\n  ${failures.join('\n  ')}\n`)
  process.exit(1)
}
process.stdout.write('client bundle contract OK\n')
