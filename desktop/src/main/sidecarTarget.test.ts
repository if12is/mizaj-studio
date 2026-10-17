import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { resolveSidecar } from './pythonManager'

const base = {
  resourcesPath: '/opt/Mizaj/resources',
  backendDir: '/repo/backend',
  userDataDir: '/home/u/.config/mizaj',
  env: {}
}

describe('resolveSidecar', () => {
  it('dev: python -m app.main from backend/', () => {
    const t = resolveSidecar({ ...base, isPackaged: false, platform: 'linux', exists: () => true })
    expect(t.pythonExe).toBe(join('/repo/backend', '.venv', 'bin', 'python'))
    expect(t.prefixArgs).toEqual(['-m', 'app.main'])
    expect(t.backendDir).toBe('/repo/backend')
    expect(t.extraEnv).toEqual({})
  })
  it('dev honours MIZAJ_PYTHON', () => {
    const t = resolveSidecar({ ...base, env: { MIZAJ_PYTHON: '/x/py' }, isPackaged: false })
    expect(t.pythonExe).toBe('/x/py')
  })
  it('packaged linux/mac: frozen engine, no python args, bundled models env', () => {
    const t = resolveSidecar({ ...base, isPackaged: true, platform: 'linux', exists: () => false })
    expect(t.pythonExe).toBe(join('/opt/Mizaj/resources', 'engine', 'mizaj-engine'))
    expect(t.prefixArgs).toEqual([])
    expect(t.backendDir).toBe(join('/opt/Mizaj/resources', 'engine'))
    expect(t.extraEnv.MIZAJ_MODELS_DIR).toBe(join('/opt/Mizaj/resources', 'models', 'catt_eo'))
  })
  it('packaged windows uses mizaj-engine.exe', () => {
    const t = resolveSidecar({ ...base, isPackaged: true, platform: 'win32', exists: () => false })
    expect(t.pythonExe.endsWith('mizaj-engine.exe')).toBe(true)
  })
  it('packaged: no models env when a pack exists in userData/models', () => {
    const t = resolveSidecar({
      ...base,
      isPackaged: true,
      platform: 'linux',
      exists: (p) => p === join('/home/u/.config/mizaj', 'models')
    })
    expect(t.extraEnv).toEqual({})
  })
})
