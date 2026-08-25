import { describe, expect, it, vi } from "vitest"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { init, patchProfile } from "../src/cli/init.js"

describe("init UX", () => {
  it("atomically appends a non-secret managed profile patch and is idempotent", async () => {
    const home=await mkdtemp(join(tmpdir(),"mesh-init-")), dir=join(home,"profiles","UX")
    await mkdir(dir,{recursive:true}); await writeFile(join(dir,"cordis.patch.yml"),"# mine\n[]\n")
    expect(await patchProfile("UX",home)).toBe(true); expect(await patchProfile("UX",home)).toBe(false)
    const value=await readFile(join(dir,"cordis.patch.yml"),"utf8")
    expect(value.match(/dsh-agent-mesh init/g)).toHaveLength(1); expect(value).toContain("# mine"); expect(value).not.toMatch(/token|secret/i)
  })
  it("rejects profile traversal", async () => { await expect(patchProfile("../oops", "/tmp/x")).rejects.toThrow("unsafe") })
  it("performs a read-only checkup without executing when sam-node is absent", async () => {
    const home=await mkdtemp(join(tmpdir(),"mesh-init-")), out=vi.fn(), err=vi.fn(), approve=vi.fn(async()=>true)
    const result=await init({profile:"UX",dshHome:home,samNode:join(home,"missing"),yes:true,start:true,join:true}, {out,err,approve})
    expect(result.changed).toEqual([]); expect(result.planned).toEqual([]); expect(err).toHaveBeenCalledWith(expect.stringContaining("no node-state changes"))
  })
})
