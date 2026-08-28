// Moved to @morewax/sam-mesh (generic mesh infra, shared with the chat plugin).
// Old names kept as aliases for existing imports.
import { SamServiceRegistrationClient as Client, type SamRegistrationTransport, type SamRegistrationOptions, type SamServiceRegistration } from '@morewax/sam-mesh'
export const SamTaskRegistrationClient = Client
export type { SamRegistrationTransport, SamRegistrationOptions, SamServiceRegistration }
export type TaskServiceRegistration = SamServiceRegistration
export type TaskRegistrationOptions = SamRegistrationOptions
