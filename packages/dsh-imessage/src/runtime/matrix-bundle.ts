import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DeploymentBundle } from './interface.js'
import { RuntimeError } from './errors.js'

export interface MatrixSecrets { postgresPassword: string; synapseRegistrationSecret: string; synapseMacaroonSecret: string; synapseSigningKey: string }
export interface MatrixBundleOptions { assetDir: string; outputDir: string; namespace: string; serverName: string; secrets?: MatrixSecrets }
const TOKEN = /{{([A-Z0-9_]+)}}/g
function randomSecret(bytes = 32): string { return randomBytes(bytes).toString('base64url') }
export function generateMatrixSecrets(): MatrixSecrets { return { postgresPassword: randomSecret(), synapseRegistrationSecret: randomSecret(), synapseMacaroonSecret: randomSecret(), synapseSigningKey: `ed25519 dsh1 ${randomSecret(32)}` } }
function validDns(value: string): boolean { return /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(value) && value.length <= 253 }
function quote(value: string): string { return JSON.stringify(value) }

export function synapseConfig(namespace: string, serverName: string, secrets: MatrixSecrets): string {
  return `server_name: ${quote(serverName)}\npid_file: /data/homeserver.pid\npublic_baseurl: http://synapse.${namespace}.svc:8008/\nlisteners:\n  - port: 8008\n    tls: false\n    type: http\n    x_forwarded: true\n    resources:\n      - names: [client]\ndatabase:\n  name: psycopg2\n  args:\n    user: synapse\n    password: ${quote(secrets.postgresPassword)}\n    database: synapse\n    host: postgres.${namespace}.svc\n    cp_min: 5\n    cp_max: 10\nregistration_shared_secret: ${quote(secrets.synapseRegistrationSecret)}\nmacaroon_secret_key: ${quote(secrets.synapseMacaroonSecret)}\nform_secret: ${quote(randomSecret())}\nsigning_key_path: /data/signing.key\nenable_registration: false\nreport_stats: false\nmedia_store_path: /data/media_store\nsearch_all_users: false\n`
}

function secretManifest(namespace: string, secrets: MatrixSecrets, homeserver: string): string {
  const data: Record<string, string> = { POSTGRES_USER: 'synapse', POSTGRES_DB: 'synapse', POSTGRES_PASSWORD: secrets.postgresPassword }
  const encoded = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))
  const configData = { 'homeserver.yaml': Buffer.from(homeserver).toString('base64'), 'signing.key': Buffer.from(secrets.synapseSigningKey).toString('base64') }
  return `apiVersion: v1\nkind: Secret\nmetadata: { name: dsh-imessage-secrets, namespace: ${namespace} }\ntype: Opaque\ndata:\n${Object.entries(encoded).map(([key, value]) => `  ${key}: ${value}`).join('\n')}\n---\napiVersion: v1\nkind: Secret\nmetadata: { name: dsh-imessage-synapse-config, namespace: ${namespace} }\ntype: Opaque\ndata:\n${Object.entries(configData).map(([key, value]) => `  ${key}: ${value}`).join('\n')}\n`
}

async function privateWrite(path: string, value: string): Promise<void> { const temporary = `${path}.${process.pid}.tmp`; const handle = await open(temporary, 'wx', 0o600); try { await handle.writeFile(value); await handle.sync() } finally { await handle.close() }; await rename(temporary, path); await chmod(path, 0o600) }

export async function renderMatrixBundle(options: MatrixBundleOptions): Promise<{ bundle: DeploymentBundle; secrets: MatrixSecrets; digest: string }> {
  if (!validDns(options.namespace) || !validDns(options.serverName)) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', 'Invalid Matrix namespace or server name', undefined, false)
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 }); const secrets = options.secrets ?? generateMatrixSecrets(); const paths: string[] = []
  const homeserver = synapseConfig(options.namespace, options.serverName, secrets)
  const generated = join(options.outputDir, '00-secrets.yaml'); await privateWrite(generated, secretManifest(options.namespace, secrets, homeserver)); paths.push(generated)
  for (const name of (await readdir(options.assetDir)).filter(name => name.endsWith('.yaml.tmpl')).sort()) {
    const source = await readFile(join(options.assetDir, name), 'utf8'); const rendered = source.replaceAll('{{NAMESPACE}}', options.namespace)
    const unknown = [...rendered.matchAll(TOKEN)].map(match => match[1]); if (unknown.length) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', `Unknown manifest template tokens: ${unknown.join(', ')}`, undefined, false)
    if (/image:\s*[^\s@]+:[^\s]+/.test(rendered) || /REPLACE_ME|latest/i.test(rendered)) throw new RuntimeError('IMESSAGE_RUNTIME_INVALID_BUNDLE', `Mutable or placeholder content in ${basename(name)}`, undefined, false)
    const target = join(options.outputDir, name.replace(/\.tmpl$/, '')); await privateWrite(target, rendered); paths.push(target)
  }
  const hash = createHash('sha256'); for (const path of paths) hash.update(await readFile(path)); const digest = hash.digest('hex')
  return { bundle: { namespace: options.namespace, manifestPaths: paths, id: 'synapse-postgres', version: digest.slice(0, 16) }, secrets, digest }
}
