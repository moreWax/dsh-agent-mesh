import type { ServiceRegistrationRequest, SkillInstallRequest } from "./types.js"

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const requiredString = (o: Record<string, unknown>, key: string): string => {
  const value = o[key]
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${key} must be a non-empty string`)
  return value
}
/** Parse untrusted input into a registration request. Unknown fields are discarded. */
export function parseServiceRegistrationRequest(value: unknown): ServiceRegistrationRequest {
  if (!record(value)) throw new TypeError("service registration must be an object")
  const endpoint = requiredString(value, "endpoint")
  let target: URL
  try { target = new URL(endpoint) } catch { throw new TypeError("endpoint must be an absolute HTTP URL") }
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new TypeError("endpoint must use http or https")
  if (target.username || target.password) throw new TypeError("endpoint must not contain credentials")
  const output: ServiceRegistrationRequest = { name: requiredString(value, "name"), protocol: requiredString(value, "protocol"), endpoint: target.toString() }
  if (value.metadata !== undefined) {
    if (!record(value.metadata)) throw new TypeError("metadata must be an object")
    output.metadata = value.metadata
  }
  if (value.ttlSeconds !== undefined) {
    if (!Number.isSafeInteger(value.ttlSeconds) || (value.ttlSeconds as number) <= 0) throw new TypeError("ttlSeconds must be a positive integer")
    output.ttlSeconds = value.ttlSeconds as number
  }
  return output
}
export function parseSkillInstallRequest(value: unknown): SkillInstallRequest {
  if (!record(value)) throw new TypeError("skill install request must be an object")
  const output: SkillInstallRequest = { source: requiredString(value, "source") }
  for (const key of ["name", "version", "target"] as const) if (value[key] !== undefined) output[key] = requiredString(value, key)
  if (value.force !== undefined) {
    if (typeof value.force !== "boolean") throw new TypeError("force must be boolean")
    output.force = value.force
  }
  return output
}
// Schema-shaped exports are useful to command/HTTP adapters without coupling this module to one validator.
export const serviceRegistrationRequestSchema = { parse: parseServiceRegistrationRequest }
export const skillInstallRequestSchema = { parse: parseSkillInstallRequest }
