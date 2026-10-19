import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CONFIG,
  SystemwideConfigStore,
  applyPatch,
  cloneDefault,
  sanitizeConfig
} from './config'
import {
  conflictMessageAr,
  validateAccelerator,
  validateShortcutSet,
  type ShortcutError
} from './shortcuts'

const err = (a: string): ShortcutError | null => {
  const r = validateAccelerator(a)
  return r.ok ? null : r.error
}

describe('validateAccelerator', () => {
  it('accepts and normalises valid combinations', () => {
    expect(validateAccelerator('Ctrl+Alt+M')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+M' })
    expect(validateAccelerator('alt+ctrl+m')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+M' })
    expect(validateAccelerator('CommandOrControl+Shift+F9')).toEqual({
      ok: true,
      accelerator: 'Ctrl+Shift+F9'
    })
    expect(validateAccelerator('Control+Alt+1')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+1' })
    expect(validateAccelerator('Alt+Space')).toMatchObject({ ok: false }) // reserved
    expect(validateAccelerator('Ctrl+Alt+Up')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+Up' })
    expect(validateAccelerator('Ctrl+Alt+Plus')).toEqual({ ok: true, accelerator: 'Ctrl+Alt+Plus' })
  })

  it('rejects bad syntax', () => {
    for (const a of [
      '',
      'Ctrl+',
      '+M',
      'Ctrl+Alt',
      'Ctrl+Foo',
      'M+Ctrl',
      'Ctrl++Alt',
      'Ctrl+Alt+MM',
      'Ctrl+Alt+é'
    ])
      expect(err(a)).toBe('syntax')
    expect(err(undefined as unknown as string)).toBe('syntax')
    expect(err('Ctrl+Alt+' + 'x'.repeat(100))).toBe('too_long')
  })

  it('requires Ctrl or Alt', () => {
    expect(err('M')).toBe('no_modifier')
    expect(err('Shift+M')).toBe('no_modifier')
    expect(err('F9')).toBe('no_modifier')
    expect(err('Shift+F9')).toBe('no_modifier')
  })

  it('refuses the Windows key', () => {
    expect(err('Super+M')).toBe('windows_key')
    expect(err('Ctrl+Meta+M')).toBe('windows_key')
    expect(err('Cmd+Alt+M')).toBe('windows_key')
  })

  it('refuses combinations the feature or the system needs', () => {
    for (const a of [
      'Ctrl+C',
      'Ctrl+V',
      'Ctrl+X',
      'Ctrl+Z',
      'Ctrl+A',
      'Alt+F4',
      'Alt+Tab',
      'Ctrl+Shift+Esc',
      'Ctrl+Alt+Delete',
      'shift+insert'
    ])
      expect(err(a), a).toBe(a.toLowerCase().startsWith('shift') ? 'no_modifier' : 'reserved')
  })
})

describe('validateShortcutSet', () => {
  it('treats empty as unset and keeps valid ones', () => {
    const r = validateShortcutSet({ main: 'ctrl+alt+m', tashkeel: 'Ctrl+Alt+T' })
    expect(r.errors).toEqual({})
    expect(r.accelerators).toEqual({
      main: 'Ctrl+Alt+M',
      proofread: '',
      punctuation: '',
      tashkeel: 'Ctrl+Alt+T',
      all: ''
    })
  })

  it('detects duplicates regardless of spelling', () => {
    const r = validateShortcutSet({ main: 'Ctrl+Alt+M', all: 'alt+control+m' })
    expect(r.errors).toEqual({ all: 'duplicate' })
    expect(r.accelerators.all).toBe('')
  })

  it('reports each invalid entry', () => {
    const r = validateShortcutSet({ main: 'M', proofread: 'Ctrl+C', punctuation: 'x+y' })
    expect(r.errors).toEqual({ main: 'no_modifier', proofread: 'reserved', punctuation: 'syntax' })
  })
})

describe('conflictMessageAr', () => {
  it('names the operation and the accelerator', () => {
    const m = conflictMessageAr('tashkeel', 'Ctrl+Alt+T')
    expect(m).toContain('Ctrl+Alt+T')
    expect(m).toContain('تشكيل')
    expect(m).toContain('يستعمله برنامج آخر')
  })
})

describe('config', () => {
  it('is off by default with a preview-first mode and the main shortcut set', () => {
    expect(DEFAULT_CONFIG.enabled).toBe(false)
    expect(DEFAULT_CONFIG.runInBackground).toBe(false)
    expect(DEFAULT_CONFIG.replaceMode).toBe('preview')
    expect(DEFAULT_CONFIG.shortcuts.main).toBe('Ctrl+Alt+M')
    expect(Object.values({ ...DEFAULT_CONFIG.shortcuts, main: '' }).every((v) => v === '')).toBe(
      true
    )
  })

  it('sanitizeConfig repairs garbage and never throws', () => {
    expect(sanitizeConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(sanitizeConfig('x')).toEqual(DEFAULT_CONFIG)
    const c = sanitizeConfig({
      enabled: 'yes',
      replaceMode: 'weird',
      shortcuts: { main: 'bad', all: 'ctrl+alt+k', tashkeel: 5 }
    })
    expect(c.enabled).toBe(false)
    expect(c.replaceMode).toBe('preview')
    expect(c.shortcuts.main).toBe('')
    expect(c.shortcuts.all).toBe('Ctrl+Alt+K')
    expect(c.shortcuts.tashkeel).toBe('')
  })

  it('applyPatch validates and keeps the old value of a refused field', () => {
    const cur = cloneDefault()
    const r = applyPatch(cur, {
      enabled: true,
      replaceMode: 'direct',
      shortcuts: { all: 'Ctrl+Alt+A', tashkeel: 'Ctrl+C', proofread: 'Ctrl+Alt+M' },
      evil: 1
    })
    expect(r.config.enabled).toBe(true)
    expect(r.config.replaceMode).toBe('direct')
    expect(r.config.shortcuts.all).toBe('Ctrl+Alt+A')
    expect(r.config.shortcuts.tashkeel).toBe('')
    expect(r.config.shortcuts.proofread).toBe('')
    expect(r.errors).toEqual({ tashkeel: 'reserved', proofread: 'duplicate' })
    expect('evil' in r.config).toBe(false)
    expect(cur.enabled).toBe(false) // input not mutated
  })

  it('applyPatch rejects wrong types and lets two shortcuts be swapped', () => {
    const base = {
      ...cloneDefault(),
      shortcuts: { ...cloneDefault().shortcuts, all: 'Ctrl+Alt+K' }
    }
    const bad = applyPatch(base, { enabled: 'x', replaceMode: 3, shortcuts: { main: 7 } })
    expect(bad.errors).toEqual({ enabled: 'invalid', replaceMode: 'invalid', main: 'syntax' })
    expect(bad.config.shortcuts.main).toBe('Ctrl+Alt+M')
    const swap = applyPatch(base, { shortcuts: { main: 'Ctrl+Alt+K', all: 'Ctrl+Alt+M' } })
    expect(swap.errors).toEqual({})
    expect(swap.config.shortcuts.main).toBe('Ctrl+Alt+K')
    expect(swap.config.shortcuts.all).toBe('Ctrl+Alt+M')
    const dup = applyPatch(base, { shortcuts: { main: 'Ctrl+Alt+K' } })
    expect(dup.errors).toEqual({ main: 'duplicate' })
    expect(dup.config.shortcuts.main).toBe('Ctrl+Alt+M')
  })

  it('applyPatch ignores non-object patches', () => {
    expect(applyPatch(cloneDefault(), null).config).toEqual(DEFAULT_CONFIG)
    expect(applyPatch(cloneDefault(), 'x').errors).toEqual({})
  })

  it('persists atomically and reloads; corrupt file gives defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-sw-'))
    try {
      const file = join(dir, 'systemwide-config.json')
      const store = new SystemwideConfigStore(file)
      expect(store.load()).toEqual(DEFAULT_CONFIG)
      const c = applyPatch(cloneDefault(), { enabled: true, runInBackground: true }).config
      store.save(c)
      expect(new SystemwideConfigStore(file).load()).toEqual(c)
      expect(JSON.parse(readFileSync(file, 'utf8')).enabled).toBe(true)
      writeFileSync(file, '{not json')
      expect(store.load()).toEqual(DEFAULT_CONFIG)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
