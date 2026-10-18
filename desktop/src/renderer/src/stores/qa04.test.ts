import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings'
import { useQualityStore } from './quality'

beforeAll(() => {
  setActivePinia(createPinia())
  const events: string[] = []
  vi.stubGlobal(
    'CustomEvent',
    class CustomEvent {
      constructor(
        public type: string,
        public init?: unknown
      ) {}
    }
  )
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false }),
    dispatchEvent: (e: { type: string }) => events.push(e.type)
  })
})

describe('v0.4 QA: the Quran banner button really opens the settings', () => {
  it('quality.openSettings("quran") opens the dialog on the Quran section', () => {
    const settings = useSettingsStore()
    const quality = useQualityStore()
    expect(settings.settingsOpen).toBe(false)
    quality.openSettings('quran')
    expect(settings.settingsOpen).toBe(true)
    expect(settings.settingsSection).toBe('quran')
  })
  it('installing the Quran text clears the "not installed" banner state at once', () => {
    const quality = useQualityStore()
    quality.quranInstalled = false
    const rev = quality.quranRevision
    quality.quranChanged(true)
    expect(quality.quranInstalled).toBe(true)
    expect(quality.quranRevision).toBe(rev + 1) // the editor watches this to re-detect
  })
  it('an unknown section falls back to general instead of a blank dialog', () => {
    const settings = useSettingsStore()
    const quality = useQualityStore()
    quality.openSettings('nope')
    expect(settings.settingsSection).toBe('general')
  })
})
