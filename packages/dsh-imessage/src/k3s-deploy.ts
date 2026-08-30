import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'

/**
 * k3s cluster bootstrap + Matrix stack deployment.
 * Called from the plugin at boot on Linux — the plugin IS the deployment
 * vehicle: it ensures k3s is running, then applies the manifests it ships.
 */

const exec = promisify(execFile)

async function sh(cmd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await exec(cmd, args, { timeout: timeoutMs })
  return stdout
}

/** Check whether a k3s cluster is already running and kubectl works. */
export async function hasCluster(): Promise<boolean> {
  try {
    await sh('k3s', ['kubectl', 'get', 'nodes'], 5_000)
    return true
  } catch {
    return false
  }
}

/** Install k3s (single node) if not already present. */
export async function ensureK3s(): Promise<void> {
  if (await hasCluster()) return
  console.log('[dsh-imessage] bootstrapping k3s...')
  await sh('curl', ['-sfL', 'https://get.k3s.io', '-o', '/tmp/k3s-install.sh'])
  await sh('sh', ['/tmp/k3s-install.sh', '--write-kubeconfig-mode', '644'], 120_000)
  // wait for ready
  for (let i = 0; i < 10; i++) {
    if (await hasCluster()) return
    await new Promise(r => setTimeout(r, 3000))
  }
  throw new Error('k3s did not become ready')
}

/** Ensure a k3s cluster is available: download and install if missing. */
export async function ensureCluster(): Promise<void> {
  if (await hasCluster()) return
  await ensureK3s()
}

/** Deploy the Matrix stack (Synapse + corten-matrix + Conduit) into the namespace. */
export async function deployStack(namespace: string): Promise<void> {
  await sh('k3s', ['kubectl', 'create', 'namespace', namespace]).catch(() => {})
  // Apply manifests from the repo's k8s/matrix/ directory (shipped with the plugin)
  const manifestDir = join(dirname(new URL(import.meta.url).pathname), 'k8s')
  await sh('k3s', ['kubectl', 'apply', '-f', manifestDir, '-n', namespace], 30_000)
}

/** Wait for all pods in the namespace to be Ready. */
export async function waitForHealthy(namespace: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const out = await sh('k3s', ['kubectl', 'get', 'pods', '-n', namespace, '--no-headers']).catch(() => '')
    if (!out.includes('Pending') && !out.includes('ContainerCreating') && !out.includes('Error')) return
    await new Promise(r => setTimeout(r, 3000))
  }
}
