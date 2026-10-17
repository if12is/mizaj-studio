import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '@renderer/api'
import type { SettingsMap } from '@renderer/api/client'

export const DEFAULT_SETTINGS: SettingsMap = {
  engine_mode: 'fast',
  tashkeel_level: 'full',
  editor_font: 'Amiri',
  editor_font_size: '20',
  colored_diacritics: 'true',
  diacritic_color: 'emerald',
  theme: 'dark'
}

export const useSettingsStore = defineStore('settings', () => {
  const values = ref<SettingsMap>({ ...DEFAULT_SETTINGS })
  const isDark = computed(() => values.value.theme !== 'light')
  const fontSize = computed(() => Number(values.value.editor_font_size) || 20)
  const colored = computed(() => values.value.colored_diacritics === 'true')

  function applyToDom(): void {
    const root = document.documentElement
    root.classList.toggle('dark', isDark.value)
    root.style.setProperty('--editor-font', `'${values.value.editor_font}'`)
    root.style.setProperty('--editor-size', `${fontSize.value}px`)
  }

  async function load(): Promise<void> {
    try {
      values.value = { ...DEFAULT_SETTINGS, ...(await useApi().get<SettingsMap>('/api/settings')) }
    } catch {
      /* keep defaults */
    }
    applyToDom()
  }

  /** Applies immediately (optimistic), then persists; rolls back on failure. */
  async function update(patch: SettingsMap): Promise<void> {
    const prev = values.value
    values.value = { ...prev, ...patch }
    applyToDom()
    try {
      values.value = {
        ...DEFAULT_SETTINGS,
        ...(await useApi().put<SettingsMap>('/api/settings', patch))
      }
    } catch {
      values.value = prev
    }
    applyToDom()
  }

  return { values, isDark, fontSize, colored, load, update, applyToDom }
})
