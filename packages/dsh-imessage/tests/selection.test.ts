import { describe, expect, it } from 'vitest'
import { platformOf, selectBackend } from '../src/backends/select.js'
import { nextSetupActions, setupState } from '../src/setup.js'

describe('backend selection', () => {
  it('chooses native only on macOS and matrix only on Linux', () => {
    expect(platformOf('darwin')).toBe('darwin')
    expect(platformOf('linux')).toBe('linux')
    expect(selectBackend('auto', 'darwin')).toBe('native')
    expect(selectBackend('auto', 'linux')).toBe('matrix')
    expect(selectBackend('native', 'linux')).toBe('unsupported')
    expect(selectBackend('matrix', 'darwin')).toBe('unsupported')
  })
})

describe('resumable setup state', () => {
  it('walks Linux prerequisites in order', () => {
    expect(setupState({ platform: 'linux', backend: 'matrix', runtimeReady: false })).toBe('linux-needs-runtime')
    expect(setupState({ platform: 'linux', backend: 'matrix', runtimeReady: true, hardwareKeyPresent: false })).toBe('linux-needs-hardware-key')
    expect(setupState({ platform: 'linux', backend: 'matrix', runtimeReady: true, hardwareKeyPresent: true, matrixConfigured: false })).toBe('matrix-needs-config')
    expect(nextSetupActions('linux-needs-hardware-key')[0]?.id).toBe('provide-key')
  })
  it('reports native permission and unsupported platform', () => {
    expect(setupState({ platform: 'darwin', backend: 'native', nativeReadable: false })).toBe('native-needs-permission')
    expect(setupState({ platform: 'other', backend: 'unsupported' })).toBe('failed')
  })
})
