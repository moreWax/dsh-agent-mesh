import { describe, expect, it } from 'vitest'
import { AGENT_MESH_NS, settingsBaseFromConfig, nodeDecisionsOf } from '../src/settings.js'
import { parseAgentMeshConfig } from '../src/operator/index.js'

describe('agent-mesh settings namespace', () => {
  it('uses the kebab-case namespace the card is keyed by', () => {
    expect(String(AGENT_MESH_NS)).toBe('agent-mesh')
  })

  it('maps row config into the composition base with defaults filled', () => {
    const base = settingsBaseFromConfig(parseAgentMeshConfig({}))
    expect(base).toEqual({
      autoStartNode: true,
      autoBeginEnrollment: true,
      stopNodeOnExit: true,
      nodeControlPlane: '',
      nodeEnrollmentCredentialRef: '',
      tcpUrl: 'http://127.0.0.1:8080',
      timeoutMs: 30_000,
      preferSocket: true,
      socketPath: expect.stringContaining('sam.sock'),
    })
  })

  it('row config overrides land in the base (user layer still wins on top)', () => {
    const base = settingsBaseFromConfig(parseAgentMeshConfig({ autoStartNode: false, nodeControlPlane: 'https://cp.example' }))
    expect(base.autoStartNode).toBe(false)
    expect(base.nodeControlPlane).toBe('https://cp.example')
    expect(base.autoBeginEnrollment).toBe(true)
  })

  it('maps the enrollment credential ref into the base when configured', () => {
    const base = settingsBaseFromConfig(parseAgentMeshConfig({ nodeEnrollmentCredentialRef: 'SAM_MESH_BOOTSTRAP' }))
    expect(base.nodeEnrollmentCredentialRef).toBe('SAM_MESH_BOOTSTRAP')
  })

  it('nodeDecisionsOf projects the lifecycle subset', () => {
    const decisions = nodeDecisionsOf(settingsBaseFromConfig(parseAgentMeshConfig({ stopNodeOnExit: false })))
    expect(decisions).toEqual({
      autoStartNode: true, autoBeginEnrollment: true, stopNodeOnExit: false, nodeControlPlane: '',
    })
  })
})
