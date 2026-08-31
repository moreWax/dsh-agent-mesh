import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateMatrixSecrets, renderMatrixBundle } from '../src/runtime/matrix-bundle.js'
const dirs: string[] = []
afterEach(async () => await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('immutable Matrix bundle renderer', () => {
  it('renders private deterministic manifests with pinned images and no placeholders', async () => {
    const root = await mkdtemp(join(tmpdir(), 'im-matrix-')); dirs.push(root); const output = join(root, 'rendered')
    const secrets = { postgresPassword: 'pg-secret', synapseRegistrationSecret: 'reg-secret', synapseMacaroonSecret: 'mac-secret', synapseSigningKey: 'ed25519 dsh1 signing-secret' }
    const result = await renderMatrixBundle({ assetDir: new URL('../assets/matrix', import.meta.url).pathname, outputDir: output, namespace: 'dsh-imessage', serverName: 'matrix.example.test', secrets })
    expect(result.bundle.manifestPaths).toHaveLength(4); expect(result.digest).toMatch(/^[a-f0-9]{64}$/)
    const content = (await Promise.all(result.bundle.manifestPaths.map(path => readFile(path, 'utf8')))).join('\n')
    expect(content).not.toMatch(/REPLACE_ME|latest/i); expect(content).not.toContain('{{')
    expect(content).toContain('postgres@sha256:'); expect(content).toContain('synapse@sha256:')
    expect(content).toContain(Buffer.from('pg-secret').toString('base64'))
    for (const path of result.bundle.manifestPaths) expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it('generates unique high-entropy secret material', () => {
    const first = generateMatrixSecrets(); const second = generateMatrixSecrets()
    expect(first).not.toEqual(second); expect(first.postgresPassword.length).toBeGreaterThan(30); expect(first.synapseSigningKey).toMatch(/^ed25519 dsh1 /)
  })
  it('rejects unknown template tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'im-matrix-')); dirs.push(root); const assets = join(root, 'assets'); await (await import('node:fs/promises')).mkdir(assets); await writeFile(join(assets, 'bad.yaml.tmpl'), 'namespace: {{UNKNOWN}}')
    await expect(renderMatrixBundle({ assetDir: assets, outputDir: join(root, 'out'), namespace: 'dsh-imessage', serverName: 'matrix.test' })).rejects.toMatchObject({ code: 'IMESSAGE_RUNTIME_INVALID_BUNDLE' })
  })
})
