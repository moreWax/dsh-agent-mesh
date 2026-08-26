import { describe, expect, it, vi } from "vitest"
import { parseAgentMeshConfig } from "../src/operator/index.js"

vi.mock("node:os", () => ({ homedir: () => "/home/tester" }))

describe("parseAgentMeshConfig", () => {
  it("normalizes defaults and expands the home directory", () => {
    expect(parseAgentMeshConfig({})).toEqual({ socketPath: "/home/tester/.config/sam-mesh/sam.sock", tcpUrl: "http://127.0.0.1:8080", preferSocket: true, timeoutMs: 30_000 })
  })
  it("disables socket dialing when preferSocket is false", () => expect(parseAgentMeshConfig({ preferSocket: false }).socketPath).toBe(false))
  it("rejects URL credentials and non-HTTP protocols", () => {
    expect(() => parseAgentMeshConfig({ tcpUrl: "http://user:pass@localhost" })).toThrow(/credentials/)
    expect(() => parseAgentMeshConfig({ tcpUrl: "file:///tmp/node" })).toThrow(/http or https/)
  })
  it("keeps only credential references and rejects raw secrets", () => {
    expect(parseAgentMeshConfig({ nodeCredentialRef: " SAM_NODE_TOKEN ", unknown: true } as never)).toMatchObject({ nodeCredentialRef: "SAM_NODE_TOKEN" })
    expect(() => parseAgentMeshConfig({ apiToken: "secret" } as never)).toThrow(/raw node tokens/)
  })
})

describe('enrollment credential reference', () => {
  it('carries nodeEnrollmentCredentialRef through', () => {
    expect(parseAgentMeshConfig({ nodeEnrollmentCredentialRef: 'SAM_MESH_BOOTSTRAP' }).nodeEnrollmentCredentialRef).toBe('SAM_MESH_BOOTSTRAP')
    expect(parseAgentMeshConfig({}).nodeEnrollmentCredentialRef).toBeUndefined()
  })

  it('rejects raw bootstrap tokens in config — references only', () => {
    expect(() => parseAgentMeshConfig({ bootstrapToken: 'sam-bt-abc' })).toThrow(/forbidden in config/)
  })
})
