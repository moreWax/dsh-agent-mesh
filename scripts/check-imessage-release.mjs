import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(process.argv[2] ?? '.')
const pkg = join(root, 'packages/dsh-imessage')
const failures = []
const templates = (await readdir(join(pkg, 'assets/matrix'))).filter(name => name.endsWith('.tmpl'))
if (!templates.length) failures.push('no Matrix templates')
const corten = JSON.parse(await readFile(join(pkg, 'assets/matrix/40-corten-required.json'), 'utf8'))
if (corten.version !== '1.2.2' || corten.delivery !== 'verified-host-binary') failures.push('invalid corten deployment descriptor')
for (const name of templates) {
  const value = await readFile(join(pkg, 'assets/matrix', name), 'utf8')
  if (/REPLACE_ME|\blatest\b/i.test(value)) failures.push(`${name}: placeholder or latest`)
  for (const line of value.split(/\r?\n/)) if (/^\s*image:/.test(line) && !/@sha256:[a-f0-9]{64}\s*$/.test(line)) failures.push(`${name}: unpinned image: ${line.trim()}`)
  const unknown = [...value.matchAll(/{{([^}]+)}}/g)].map(match => match[1]).filter(token => token !== 'NAMESPACE')
  if (unknown.length) failures.push(`${name}: unknown tokens ${unknown.join(',')}`)
}
const artifacts = JSON.parse(await readFile(join(pkg, 'assets/runtime/artifacts.json'), 'utf8'))
for (const [platform, entries] of Object.entries(artifacts.artifacts)) {
  for (const artifact of entries) {
    if (!/^https:\/\//.test(artifact.url) || /\/latest(?:\/|$)/.test(artifact.url)) failures.push(`${platform}/${artifact.name}: mutable URL`)
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) failures.push(`${platform}/${artifact.name}: invalid SHA-256`)
  }
}
const packageJson = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'))
if (!packageJson.files?.includes('assets')) failures.push('package files excludes assets')
if (failures.length) { console.error(failures.join('\n')); process.exit(1) }
console.log(`release assets valid: ${templates.length} Matrix templates, ${Object.values(artifacts.artifacts).flat().length} pinned runtime artifacts`)
