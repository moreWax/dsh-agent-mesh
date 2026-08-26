import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SamNodeManager } from '../src/node/manager.js'

let dir: string
let fakeBin: string
let savedPath: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'binopts-'))
  fakeBin = await mkdtemp(join(tmpdir(), 'binopts-bin-'))
  await writeFile(join(fakeBin, 'sam-node'), '#!/bin/sh\nexit 0\n')
  await chmod(join(fakeBin, 'sam-node'), 0o755)
  savedPath = process.env.PATH
  process.env.PATH = fakeBin
})
afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  await rm(dir, { recursive: true, force: true })
  await rm(fakeBin, { recursive: true, force: true })
})

describe('SamNodeManager.binaryOptions', () => {
  it('lists PATH hits and always marks exactly one suggestion', async () => {
    const nodes = new SamNodeManager({ dataDir: dir })
    const options = await nodes.binaryOptions()
    expect(options.some(o => o.path === join(fakeBin, 'sam-node') && o.source === 'path')).toBe(true)
    expect(options.filter(o => o.suggested)).toHaveLength(1)
  })

  it('suggests the bundled binary when the platform package ships one, else the PATH hit', async () => {
    const nodes = new SamNodeManager({ dataDir: dir })
    const options = await nodes.binaryOptions()
    const suggested = options.find(o => o.suggested)!
    // On platforms with a vendored package the bundle wins; elsewhere the
    // first PATH hit is the suggestion. Either way: never an env entry.
    expect(['bundled', 'path']).toContain(suggested.source)
    if (options.some(o => o.source === 'bundled')) expect(suggested.source).toBe('bundled')
  })

  it('lists an explicit env/option override first but never suggests it', async () => {
    const explicit = join(fakeBin, 'sam-node')
    const nodes = new SamNodeManager({ dataDir: dir, samNode: explicit })
    const options = await nodes.binaryOptions()
    const env = options.find(o => o.source === 'env')
    expect(env?.path).toBe(explicit)
    expect(env?.suggested).toBe(false)
    expect(options.filter(o => o.suggested)).toHaveLength(1)
  })
})
