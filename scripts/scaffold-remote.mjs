#!/usr/bin/env node
/**
 * scaffold:remote — add a card remote across all four surfaces in one step.
 *
 *   node scripts/scaffold-remote.mjs <methodName> [--approval] [--request]
 *
 * Generates: host.ts @Remote stub (class end), remote.ts interface entry +
 * descriptor (zod), client type + factory entries, and updates the strict
 * surface test (method array + descriptor count). After scaffolding: fill in
 * the host method body + zod result shape, then pnpm -r build && CI=1 pnpm -r test.
 *
 * --approval adds the ApprovedAction second parameter (human-gated mutation).
 * --request  adds a request object first parameter.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'packages/dsh-agent-mesh')

const [, , name, ...flags] = process.argv
if (!name || !/^[a-z][a-zA-Z0-9]*$/.test(name)) {
  process.stderr.write('usage: node scripts/scaffold-remote.mjs <methodName> [--approval] [--request]\n')
  process.exit(2)
}
const approval = flags.includes('--approval')
const request = flags.includes('--request')

const edit = (path, anchor, insert, before = true) => {
  const text = readFileSync(path, 'utf8')
  const at = text.indexOf(anchor)
  if (at === -1) throw new Error(`anchor not found in ${path}: ${anchor.slice(0, 60)}`)
  const next = before ? text.slice(0, at) + insert + text.slice(at) : text.slice(0, at + anchor.length) + insert + text.slice(at + anchor.length)
  writeFileSync(path, next)
  process.stdout.write(`+ ${path.replace(ROOT + '/', '')}\n`)
}

const params = [...(request ? ['request: Record<string, unknown>'] : []), ...(approval ? ['approval: ApprovedAction'] : [])].join(', ')
const hostParams = [...(request ? ['request: Record<string, unknown>'] : []), ...(approval ? ['approval: ApprovedAction'] : [])].join(', ')

// 1. host method (before class-end anchor)
edit(join(PLUGIN, 'src/web/host.ts'), '// scaffold-anchor: host-method',
  `  @Remote("${name}") async ${name}(${hostParams}): Promise<unknown> {
    throw new Error("${name}: not implemented — fill in the scaffold stub")
  }

  `)

// 2a. remote.ts interface entry
edit(join(PLUGIN, 'src/remote.ts'), '// scaffold-anchor: interface',
  `  ${name}(${params}): Promise<RemoteResult<unknown>>
  `)
// 2b. remote.ts descriptor (before array end)
const zodParams = [...(request ? ['parameter("request",z.record(z.string(),z.unknown()))'] : []), ...(approval ? ['parameter("approval",approval)'] : [])].join(',')
edit(join(PLUGIN, 'src/remote.ts'), '/* scaffold-anchor: descriptors */',
  `,descriptor("${name}",[${zodParams}],z.unknown())`)

// 3a. client type
const clientParams = [...(request ? ['q:Record<string,unknown>'] : []), ...(approval ? ['a:ApprovedAction'] : [])].join(',')
edit(join(PLUGIN, 'src/client/index.tsx'), '/* scaffold-anchor: api-type */',
  ` ${name}(${clientParams}):Promise<unknown>;`)
// 3b. client factory
const clientArgs = [...(request ? ['q'] : []), ...(approval ? ['a'] : [])].join(',')
edit(join(PLUGIN, 'src/client/index.tsx'), '/* scaffold-anchor: api-impl */',
  `,${name}:async(${clientArgs})=>unwrap(await r.${name}(${clientArgs}))`)

// 4a. surface test method array (append before closing bracket)
edit(join(PLUGIN, 'tests/web-integration.test.ts'), '/* scaffold-anchor: surface */',
  `,"${name}"`)
// 4b. descriptor count bump
const testPath = join(PLUGIN, 'tests/web-integration.test.ts')
const testText = readFileSync(testPath, 'utf8')
const bumped = testText.replace(/toHaveLength\((\d+)(\/\* scaffold-anchor: count \*\/)\)/,
  (_, n, anchor) => `toHaveLength(${Number(n) + 1}${anchor})`)
if (bumped === testText) throw new Error('descriptor count anchor not found')
writeFileSync(testPath, bumped)
process.stdout.write('+ packages/dsh-agent-mesh/tests/web-integration.test.ts (count)\n')

process.stdout.write(`\nScaffolded '${name}'. Next: implement the host body + tighten the zod result, then pnpm -r build && CI=1 pnpm -r test\n`)
