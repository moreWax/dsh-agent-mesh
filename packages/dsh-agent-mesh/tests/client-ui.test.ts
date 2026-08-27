import { describe, expect, it } from 'vitest'
import { chipView, groupModels, wizardSteps, type WizardFacts } from '../src/client/index.js'

/** The card's first-run checklist, structured-status chips, and model roster
 * are pure view-models over live mesh state — tested here without a DOM. */

const base: WizardFacts = { installed: false, enrolled: false, running: false, pairing: false }

describe('wizardSteps', () => {
  it('a brand-new machine starts at enrollment with an install error when the binary is missing', () => {
    const steps = wizardSteps(base)
    expect(steps.map(s => s.id)).toEqual(['enroll', 'run', 'fleet', 'ready'])
    expect(steps[0]).toMatchObject({ current: true, done: false })
    expect(steps[0]?.error).toContain('sam-node')
    expect(steps[0]?.fix).toBeTruthy()
    expect(steps.filter(s => s.current)).toHaveLength(1)
  })

  it('installed but unenrolled: enroll is current with no error', () => {
    const steps = wizardSteps({ ...base, installed: true })
    expect(steps[0]).toMatchObject({ current: true, done: false })
    expect(steps[0]?.error).toBeUndefined()
    expect(steps[0]?.detail).toBeTruthy()
  })

  it('enrolled but stopped: the run step becomes current', () => {
    const steps = wizardSteps({ ...base, installed: true, enrolled: true })
    expect(steps[0]?.done).toBe(true)
    expect(steps[1]).toMatchObject({ id: 'run', current: true, done: false })
  })

  it('running without a fleet: the fleet step is current', () => {
    const steps = wizardSteps({ ...base, installed: true, enrolled: true, running: true, fleets: [] })
    expect(steps[2]).toMatchObject({ id: 'fleet', current: true, done: false })
    expect(steps[3]?.done).toBe(false)
  })

  it('fleet membership is detected three ways: session join, provider peer id, hosting', () => {
    const running = { ...base, installed: true, enrolled: true, running: true }
    const byJoin = wizardSteps({ ...running, joinedFleet: 'acme' })
    expect(byJoin[2]).toMatchObject({ done: true, detail: 'member of acme' })
    const byProvider = wizardSteps({ ...running, ownPeer: 'p1', fleets: [{ name: 'acme', providers: 1, peerIds: ['p1', 'p2'] }] })
    expect(byProvider[2]).toMatchObject({ done: true, detail: 'member of acme' })
    const byHosting = wizardSteps({ ...running, pairing: true })
    expect(byHosting[2]).toMatchObject({ done: true })
  })

  it('all done collapses: every step done, none current', () => {
    const steps = wizardSteps({ installed: true, enrolled: true, running: true, pairing: false, joinedFleet: 'acme', fleets: [{ name: 'acme', providers: 2, peerIds: ['x'] }], peers: 3, models: 5 })
    expect(steps.every(s => s.done)).toBe(true)
    expect(steps.some(s => s.current)).toBe(false)
  })

  it('ready degrades gracefully when discovery never answered', () => {
    const steps = wizardSteps({ ...base, installed: true, enrolled: true, running: true, joinedFleet: 'acme' })
    expect(steps[3]).toMatchObject({ id: 'ready', done: false, current: true })
  })
})

describe('chipView', () => {
  it('services: name + protocol · endpoint meta', () => {
    expect(chipView('services', { id: 's1', name: 'dsh-mesh-inference', protocol: 'http', endpoint: 'http://127.0.0.1:9000' }))
      .toEqual({ name: 'dsh-mesh-inference', meta: 'http · http://127.0.0.1:9000' })
  })

  it('tools: tool_name with service and truncated peer meta', () => {
    const v = chipView('tools', { tool_name: 'task_submit', service_name: 'acme', peer_id: '0123456789abcdef' })
    expect(v.name).toBe('task_submit')
    expect(v.meta).toContain('svc acme')
    expect(v.meta).toContain('0123456789')
  })

  it('degrades on empty/garbage entries', () => {
    expect(chipView('services', {}).name).toBe('(unnamed service)')
    expect(chipView('tools', null).name).toBe('(unnamed tool)')
    expect(chipView('tools', 'nope').meta).toBe('')
  })
})

describe('groupModels', () => {
  it('groups by owned_by and badges local rows by serve state', () => {
    const models = [{ id: 'm1', owned_by: 'peer-a' }, { id: 'm2', owned_by: 'peer-b' }, { id: 'm3', owned_by: 'peer-b' }]
    const groups = groupModels(models, { models: ['m2', 'm3'], rowState: 'serving' })
    expect(groups.map(g => g.name)).toEqual(['peer-a', 'peer-b'])
    expect(groups[0]?.thisMachine).toBe(false)
    expect(groups[1]?.thisMachine).toBe(true)
    expect(groups[1]?.rows.map(r => r.badge)).toEqual(['live', 'live'])
    expect(groups[0]?.rows[0]?.badge).toBeNull()
  })

  it('maps serve row states: starting → warming, error → error', () => {
    const warming = groupModels([{ id: 'm1' }], { models: ['m1'], rowState: 'starting' })
    expect(warming[0]?.rows[0]?.badge).toBe('warming')
    const failed = groupModels([{ id: 'm1' }], { models: ['m1'], rowState: 'error' })
    expect(failed[0]?.rows[0]?.badge).toBe('error')
  })

  it('degrades to one ungrouped list when no entry carries owned_by', () => {
    const groups = groupModels([{ id: 'm1' }, { id: 'm2' }], null)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.name).toBe('mesh')
    expect(groups[0]?.rows.every(r => r.badge === null)).toBe(true)
  })

  it('marks a mixed group as not-this-machine', () => {
    const groups = groupModels([{ id: 'm1', owned_by: 'p' }, { id: 'm2', owned_by: 'p' }], { models: ['m1'], rowState: 'serving' })
    expect(groups[0]?.thisMachine).toBe(false)
  })
})
