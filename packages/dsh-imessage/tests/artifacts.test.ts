import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactInstaller, loadArtifactManifest, runtimePlatform, sha256, type ArtifactFetcher } from '../src/runtime/artifacts.js'
import { detectRootlessCapabilities } from '../src/runtime/capabilities.js'
import type { CommandRunner } from '../src/runtime/command.js'

const dirs: string[] = []
async function dir(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'im-runtime-')); dirs.push(value); return value }
afterEach(async () => await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('pinned artifact manifest', () => {
  it('contains immutable HTTPS checksums for both supported architectures', async () => {
    const manifest = await loadArtifactManifest(new URL('../assets/runtime/artifacts.json', import.meta.url).pathname)
    for (const platform of ['linux-x64', 'linux-arm64'] as const) {
      expect(manifest.artifacts[platform].map(a => a.name)).toEqual(['k3s', 'rootlesskit', 'slirp4netns', 'corten-matrix'])
      for (const artifact of manifest.artifacts[platform]) { expect(artifact.url).toMatch(/^https:\/\//); expect(artifact.url).not.toContain('latest'); expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/) }
    }
    expect(runtimePlatform('linux', 'x64')).toBe('linux-x64')
    expect(() => runtimePlatform('darwin', 'arm64')).toThrow()
  })

  it('installs a verified file atomically as mode 0700 and removes partials', async () => {
    const root = await dir(); const bytes = Buffer.from('verified executable'); const source = join(root, 'source'); await writeFile(source, bytes)
    const fetcher: ArtifactFetcher = async (_url, destination) => { await (await import('node:fs/promises')).copyFile(source, destination) }
    const installer = new ArtifactInstaller({ downloadsDir: join(root, 'downloads'), binDir: join(root, 'bin') }, fetcher)
    const result = await installer.install({ name: 'k3s', version: 'v1', url: 'https://example.test/k3s', sha256: await sha256(source), format: 'file', executables: ['k3s'] })
    expect(await readFile(result.executables[0]!, 'utf8')).toBe('verified executable'); expect((await stat(result.executables[0]!)).mode & 0o777).toBe(0o700)
    expect(await (await import('node:fs/promises')).readdir(join(root, 'downloads'))).toEqual([])
  })

  it('cleans an interrupted download and succeeds on retry', async () => {
    const root = await dir(); const bytes = Buffer.from('retry executable'); let attempts = 0
    const fetcher: ArtifactFetcher = async (_url, destination) => { attempts++; if (attempts === 1) { await writeFile(destination, 'partial'); throw new Error('interrupted') }; await writeFile(destination, bytes) }
    const installer = new ArtifactInstaller({ downloadsDir: join(root, 'downloads'), binDir: join(root, 'bin') }, fetcher)
    const artifact = { name: 'k3s' as const, version: 'v1', url: 'https://example.test/k3s', sha256: (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), format: 'file' as const, executables: ['k3s'] }
    await expect(installer.install(artifact)).rejects.toThrow('interrupted')
    expect(await (await import('node:fs/promises')).readdir(join(root, 'downloads'))).toEqual([])
    await expect(installer.install(artifact)).resolves.toMatchObject({ name: 'k3s' })
  })

  it('rejects a checksum mismatch without replacing an installed executable', async () => {
    const root = await dir(); const bin = join(root, 'bin'); await (await import('node:fs/promises')).mkdir(bin); await writeFile(join(bin, 'k3s'), 'old'); await chmod(join(bin, 'k3s'), 0o700)
    const fetcher: ArtifactFetcher = async (_url, destination) => { await writeFile(destination, 'tampered') }
    const installer = new ArtifactInstaller({ downloadsDir: join(root, 'downloads'), binDir: bin }, fetcher)
    await expect(installer.install({ name: 'k3s', version: 'v1', url: 'https://example.test/k3s', sha256: '0'.repeat(64), format: 'file', executables: ['k3s'] })).rejects.toMatchObject({ code: 'IMESSAGE_RUNTIME_INVALID_BUNDLE' })
    expect(await readFile(join(bin, 'k3s'), 'utf8')).toBe('old')
  })

  it('rejects archive traversal before extraction', async () => {
    const root = await dir(); const archive = join(root, 'archive'); await writeFile(archive, 'archive')
    const fetcher: ArtifactFetcher = async (_url, destination) => { await (await import('node:fs/promises')).copyFile(archive, destination) }
    const runner: CommandRunner = async request => request.args[0] === '-tzf' ? { stdout: '../rootlesskit\n', stderr: '' } : { stdout: '', stderr: '' }
    const installer = new ArtifactInstaller({ downloadsDir: join(root, 'downloads'), binDir: join(root, 'bin') }, fetcher, runner)
    await expect(installer.install({ name: 'rootlesskit', version: 'v1', url: 'https://example.test/a', sha256: await sha256(archive), format: 'tar.gz', executables: ['rootlesskit'] })).rejects.toMatchObject({ code: 'IMESSAGE_RUNTIME_INVALID_BUNDLE' })
  })
})

describe('rootless host capability detection', () => {
  it('checks the nearest existing parent for a not-yet-created runtime directory', async () => {
    const root = await dir()
    const checks = await detectRootlessCapabilities({ homeDir: join(root, 'not-created/nested'), minimumBytes: 1, minimumMemoryBytes: 1 })
    expect(checks.find(check => check.name === 'disk-space')).toMatchObject({ ok: true })
  })
  it('reports disabled user namespaces, cgroup, memory, and disk actionably', async () => {
    const root = await dir(); const proc = join(root, 'proc'); const fs = await import('node:fs/promises')
    await fs.mkdir(join(proc, 'sys/kernel'), { recursive: true }); await fs.mkdir(join(proc, 'sys/user'), { recursive: true })
    await writeFile(join(proc, 'sys/kernel/unprivileged_userns_clone'), '0'); await writeFile(join(proc, 'sys/kernel/apparmor_restrict_unprivileged_userns'), '1'); await writeFile(join(proc, 'sys/user/max_user_namespaces'), '0'); await writeFile(join(proc, 'filesystems'), 'nodev sysfs'); await writeFile(join(proc, 'meminfo'), 'MemAvailable: 1024 kB')
    const checks = await detectRootlessCapabilities({ homeDir: root, procDir: proc, filesystem: (async () => ({ bavail: 1, bsize: 1 })) as unknown as typeof import('node:fs/promises')['statfs'] })
    expect(checks.filter(c => c.required && !c.ok).map(c => c.name)).toEqual(['user-namespaces', 'apparmor-userns', 'user-namespace-limit', 'cgroup-v2', 'memory', 'disk-space'])
    expect(checks.filter(c => c.required && !c.ok).every(c => Boolean(c.fix))).toBe(true)
  })
})
