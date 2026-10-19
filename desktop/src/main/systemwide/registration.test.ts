import { describe, expect, it } from 'vitest'
import { cloneDefault, type SystemwideConfig } from './config'
import { DEBOUNCE_MS, ShortcutRegistry, type Registrar } from './registration'
import type { ShortcutId } from './shortcuts'

function fakeRegistrar(taken: string[] = []) {
  const live = new Map<string, () => void>()
  const r: Registrar & { live: typeof live; log: string[] } = {
    live,
    log: [],
    register(acc, cb) {
      r.log.push(`register ${acc}`)
      if (taken.includes(acc)) return false // another program owns it
      live.set(acc, cb)
      return true
    },
    unregister(acc) {
      r.log.push(`unregister ${acc}`)
      live.delete(acc)
    }
  }
  return r
}

const cfg = (
  over: Partial<SystemwideConfig> = {},
  shortcuts: Partial<Record<ShortcutId, string>> = {}
): SystemwideConfig => {
  const c = cloneDefault()
  return { ...c, enabled: true, ...over, shortcuts: { ...c.shortcuts, ...shortcuts } }
}

describe('ShortcutRegistry', () => {
  it('registers nothing while the feature is off (the default)', () => {
    const r = fakeRegistrar()
    const reg = new ShortcutRegistry(r, () => undefined)
    const st = reg.apply(cloneDefault())
    expect(r.log).toEqual([])
    expect(st.main).toMatchObject({ state: 'off', accelerator: 'Ctrl+Alt+M' })
  })

  it('registers the main shortcut and every configured operation shortcut', () => {
    const r = fakeRegistrar()
    const fired: ShortcutId[] = []
    const reg = new ShortcutRegistry(
      r,
      (id) => fired.push(id),
      () => 1_000_000
    )
    const st = reg.apply(cfg({}, { tashkeel: 'Ctrl+Alt+T', all: 'Ctrl+Alt+A' }))
    expect([...r.live.keys()].sort()).toEqual(['Ctrl+Alt+A', 'Ctrl+Alt+M', 'Ctrl+Alt+T'])
    expect(st.tashkeel.state).toBe('registered')
    expect(st.proofread).toMatchObject({ state: 'off', accelerator: '' })
    r.live.get('Ctrl+Alt+T')?.()
    expect(fired).toEqual(['tashkeel'])
  })

  it('reports a conflict when register() returns false, and keeps the others working', () => {
    const r = fakeRegistrar(['Ctrl+Alt+M'])
    const reg = new ShortcutRegistry(r, () => undefined)
    const st = reg.apply(cfg({}, { punctuation: 'Ctrl+Alt+P' }))
    expect(st.main.state).toBe('conflict')
    expect(st.main.message).toContain('Ctrl+Alt+M')
    expect(st.main.message).toContain('يستعمله برنامج آخر')
    expect(st.punctuation.state).toBe('registered')
    expect(reg.registered).toEqual(['Ctrl+Alt+P'])
  })

  it('a throwing registrar counts as a conflict', () => {
    const reg = new ShortcutRegistry(
      {
        register: () => {
          throw new Error('x')
        },
        unregister: () => undefined
      },
      () => undefined
    )
    expect(reg.apply(cfg()).main.state).toBe('conflict')
  })

  it('never registers invalid or duplicate shortcuts and explains why', () => {
    const r = fakeRegistrar()
    const reg = new ShortcutRegistry(r, () => undefined)
    const st = reg.apply(cfg({}, { all: 'Ctrl+C', tashkeel: 'Ctrl+Alt+M' }))
    expect(st.all).toMatchObject({ state: 'invalid' })
    expect(st.tashkeel).toMatchObject({ state: 'invalid' })
    expect(st.tashkeel.message).toContain('مستعمل لإجراء آخر')
    expect([...r.live.keys()]).toEqual(['Ctrl+Alt+M'])
  })

  it('unregisters everything when disabled, when the config changes, and on quit', () => {
    const r = fakeRegistrar()
    const reg = new ShortcutRegistry(r, () => undefined)
    reg.apply(cfg({}, { all: 'Ctrl+Alt+A' }))
    expect(r.live.size).toBe(2)
    reg.apply(cfg({ enabled: false }, { all: 'Ctrl+Alt+A' }))
    expect(r.live.size).toBe(0)
    reg.apply(cfg({}, { all: 'Ctrl+Alt+A' }))
    reg.apply(cfg({}, { all: 'Ctrl+Alt+B' }))
    expect([...r.live.keys()].sort()).toEqual(['Ctrl+Alt+B', 'Ctrl+Alt+M'])
    reg.unregisterAll() // will-quit
    expect(r.live.size).toBe(0)
    expect(reg.registered).toEqual([])
  })

  it('an empty main shortcut disables just the popup', () => {
    const r = fakeRegistrar()
    const reg = new ShortcutRegistry(r, () => undefined)
    reg.apply(cfg({}, { main: '', all: 'Ctrl+Alt+A' }))
    expect([...r.live.keys()]).toEqual(['Ctrl+Alt+A'])
  })

  it('ignores key-repeat but accepts a later press', () => {
    const r = fakeRegistrar()
    let t = 5_000
    const fired: ShortcutId[] = []
    const reg = new ShortcutRegistry(
      r,
      (id) => fired.push(id),
      () => t
    )
    reg.apply(cfg())
    const cb = r.live.get('Ctrl+Alt+M') as () => void
    cb()
    t += 50
    cb()
    t += DEBOUNCE_MS
    cb()
    expect(fired).toEqual(['main', 'main'])
  })
})
