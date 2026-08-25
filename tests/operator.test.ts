import { describe, expect, it, vi } from "vitest"
import { MeshOperator, parseServiceRegistrationRequest, planNodeReset, planSamNodeCommand } from "../src/operator/index.js"
import type { SamCore } from "../src/operator/index.js"

function fixture() {
  const callTool = vi.fn(async () => ({ state: "online" }))
  const core = { callTool, request: vi.fn() } as unknown as SamCore
  return { operator: new MeshOperator(core), callTool }
}
describe("MeshOperator", () => {
  it("delegates reads to the abstract core", async () => {
    const { operator, callTool } = fixture()
    await operator.status()
    expect(callTool).toHaveBeenCalledWith("node.status", {}, undefined)
  })
  it("validates and delegates service registration", async () => {
    const { operator, callTool } = fixture()
    await operator.registerService({ name: "search", protocol: "mcp", endpoint: "sam://peer/search", ignored: "x" })
    expect(callTool).toHaveBeenCalledWith("service.register", { name: "search", protocol: "mcp", endpoint: "sam://peer/search" }, undefined)
  })
  it("builds install plans but never executes them", () => {
    const { operator, callTool } = fixture()
    const plan = operator.planSkillInstall({ source: "github:org/skill", version: "1.2.0" })
    expect(plan.command.requiresApproval).toBe(true)
    expect(plan.command.approved).toBe(false)
    expect(plan.command.args).toEqual(["skill", "install", "github:org/skill", "--version", "1.2.0"])
    expect(callTool).not.toHaveBeenCalled()
  })
})
describe("command safety", () => {
  it("requires approval for reset", () => expect(planNodeReset().approved).toBe(false))
  it("records explicit reset approval", () => expect(planNodeReset({ approved: true, approvedBy: "operator" }).approved).toBe(true))
  it("quotes display text and retains argv boundaries", () => expect(planSamNodeCommand(["logs", "two words"]).display).toBe("sam-node logs 'two words'"))
  it("rejects newline injection", () => expect(() => planSamNodeCommand(["status\nreset"])).toThrow())
})
describe("schemas", () => {
  it("rejects missing required fields", () => expect(() => parseServiceRegistrationRequest({ name: "x" })).toThrow())
})
