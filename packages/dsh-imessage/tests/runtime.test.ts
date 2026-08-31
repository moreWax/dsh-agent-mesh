import { describe, expect, it, vi } from 'vitest'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExistingKubernetesRuntime } from '../src/runtime/existing-kubernetes.js'
import { ExternalMatrixRuntime } from '../src/runtime/external-matrix.js'
import { RootlessK3sRuntime } from '../src/runtime/rootless-k3s.js'
import type { CommandRequest, CommandRunner } from '../src/runtime/command.js'

async function kubeconfig(): Promise<string> { const dir = await mkdtemp(join(tmpdir(), 'im-kube-')); const path = join(dir, 'config'); await writeFile(path, 'safe', { mode: 0o600 }); return path }

function kubectlRunner(overrides: Partial<Record<string, string>> = {}): { runner: CommandRunner; calls: CommandRequest[] } {
  const calls: CommandRequest[] = []
  const runner: CommandRunner = async request => {
    calls.push(request); const key = request.args.slice(0, 3).join(' ')
    if (request.args[0] === 'version') return { stdout: '{}', stderr: '' }
    if (request.args[0] === 'auth') return { stdout: overrides[key] ?? 'yes\n', stderr: '' }
    if (request.args[0] === 'get' && request.args[1] === 'storageclass') return { stdout: overrides[key] ?? '{"items":[{}]}', stderr: '' }
    if (request.args[0] === 'create') return { stdout: 'apiVersion: v1\nkind: Namespace\n', stderr: '' }
    return { stdout: overrides[key] ?? 'ok\n', stderr: '' }
  }
  return { runner, calls }
}

describe('existing Kubernetes runtime', () => {
  it('checks API, required RBAC, and storage without a shell', async () => {
    const path = await kubeconfig(); const { runner, calls } = kubectlRunner()
    try {
      const runtime = new ExistingKubernetesRuntime({ kubeconfig: path, runner })
      const result = await runtime.detect(); expect(result.available).toBe(true)
      expect(result.checks.map(c => c.name)).toContain('create:secrets')
      expect(calls.every(call => call.command === 'kubectl' && Array.isArray(call.args))).toBe(true)
      expect(calls.every(call => call.env?.KUBECONFIG === path)).toBe(true)
    } finally { await rm(join(path, '..'), { recursive: true, force: true }) }
  })
  it('reports missing RBAC as an actionable failed check', async () => {
    const path = await kubeconfig(); const { runner } = kubectlRunner({ 'auth can-i create': 'no\n' })
    try { const result = await new ExistingKubernetesRuntime({ kubeconfig: path, runner }).detect(); expect(result.available).toBe(false); expect(result.checks.some(c => !c.ok && c.fix)).toBe(true) }
    finally { await rm(join(path, '..'), { recursive: true, force: true }) }
  })
  it('applies only explicit manifests and creates the namespace declaratively', async () => {
    const path = await kubeconfig(); const manifest = join(path, '..', 'deployment.yaml'); await writeFile(manifest, 'kind: Deployment')
    const { runner, calls } = kubectlRunner(); const runtime = new ExistingKubernetesRuntime({ kubeconfig: path, runner })
    try { await runtime.apply({ id: 'matrix', version: '1', namespace: 'dsh-imessage', manifestPaths: [manifest] }); expect(calls.some(c => c.args.join(' ').includes('apply --namespace dsh-imessage -f'))).toBe(true); expect(calls.some(c => c.input?.includes('Namespace'))).toBe(true) }
    finally { await rm(join(path, '..'), { recursive: true, force: true }) }
  })
})

describe('external Matrix runtime', () => {
  it('validates homeserver, auth, room, media, search, and bridge health', async () => {
    const requests: string[] = []
    const mock = vi.fn(async (input: string | URL | Request) => { requests.push(String(input)); return new Response('{}', { status: 200 }) }) as typeof fetch
    const runtime = new ExternalMatrixRuntime({ homeserverUrl: 'https://matrix.test', accessToken: 'secret-token', roomId: '!room:test', bridgeHealthUrl: 'https://bridge.test/health', fetch: mock })
    const result = await runtime.detect(); expect(result.available).toBe(true)
    expect(result.checks.map(c => c.name)).toEqual(['homeserver', 'credential', 'room', 'media', 'search', 'corten-bridge'])
    expect(JSON.stringify(result)).not.toContain('secret-token'); expect(requests.some(url => url.includes(encodeURIComponent('!room:test')))).toBe(true)
  })
  it('stops after rejected auth and does not leak response content', async () => {
    const mock = vi.fn(async (input: string | URL | Request) => new Response(String(input).includes('whoami') ? '{"error":"secret-token"}' : '{}', { status: String(input).includes('whoami') ? 401 : 200 })) as typeof fetch
    const result = await new ExternalMatrixRuntime({ homeserverUrl: 'https://matrix.test', accessToken: 'secret-token', roomId: '!room:test', fetch: mock }).detect()
    expect(result.available).toBe(false); expect(result.checks.at(-1)).toMatchObject({ name: 'credential', detail: 'HTTP 401' }); expect(JSON.stringify(result)).not.toContain('secret-token')
  })
})

describe('rootless task boundary', () => {
  it('never downloads or escalates before the pinned Task-5 implementation', async () => {
    const runtime = new RootlessK3sRuntime(); expect((await runtime.detect()).available).toBe(false)
    await expect(runtime.start()).rejects.toMatchObject({ code: 'IMESSAGE_RUNTIME_NOT_CONFIGURED' })
  })
})
