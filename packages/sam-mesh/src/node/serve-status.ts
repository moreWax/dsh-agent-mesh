/** Serve-row state files: the row writes truth, the card and doctor read it. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ServeStatus {
  state: 'starting' | 'serving' | 'error'
  name: string
  detail?: string | undefined
  target?: string | undefined
  models?: string[] | undefined
  updatedAt: string
}

const dir = (dataDir: string): string => join(dataDir, 'serve')
const path = (dataDir: string, name: string): string => join(dir(dataDir), `${name.replace(/[^\w.-]+/g, '_')}.json`)

export async function writeServeStatus(dataDir: string, status: Omit<ServeStatus, 'updatedAt'>): Promise<void> {
  await mkdir(dir(dataDir), { recursive: true })
  await writeFile(path(dataDir, status.name), JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2))
}

export async function readServeStatuses(dataDir: string): Promise<ServeStatus[]> {
  try {
    const out: ServeStatus[] = []
    for (const file of await readdir(dir(dataDir))) {
      if (!file.endsWith('.json')) continue
      try { out.push(JSON.parse(await readFile(join(dir(dataDir), file), 'utf8')) as ServeStatus) } catch { /* corrupt entry — skip */ }
    }
    return out
  } catch { return [] }
}
