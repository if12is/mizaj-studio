import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useApi } from '@renderer/api'
import { nextFontSize } from '@renderer/a11y/zoom'
import type { SettingsMap } from '@renderer/api/client'

export const DEFAULT_SETTINGS: SettingsMap = {
  engine_mode: 'fast',
  tashkeel_level: 'full',
  editor_font: 'Amiri',
  editor_font_size: '20',
  colored_diacritics: 'true',
  diacritic_color: 'emerald',
  auto_update_check: 'true',
  high_contrast: 'auto',
  spell_check_enabled: 'true',
  spell_cat_spelling: 'true',
  spell_cat_pattern: 'true',
  spell_cat_punctuation: 'true',
  spell_cat_typography: 'true',
  spell_cat_grammar: 'true',
  confidence_show: 'true',
  confidence_threshold: '0.75',
  quran_protect: 'true',
  // proofreading before tashkeel: ask | auto_punct (punctuation only) | off; final ya: standard | egyptian
  proofread_before_tashkeel: 'ask',
  ya_style: 'standard',
  theme: 'dark',
  // side panel layout: size in px ('' = default), dock side|bottom, collapsed true|false
  panel_width: '',
  panel_height: '',
  panel_dock: 'side',
  panel_collapsed: 'false',
  // opt-in online features (AGENTS.md section 5): always off until the user turns them on
  online_resources: 'false',
  online_languagetool: 'false'
}

export const SETTINGS_SECTIONS = [
  'general',
  'dictionary',
  'glossary',
  'quran',
  'online',
  'packs',
  'backup',
  'editor-quality'
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const useSettingsStore = defineStore('settings', () => {
  const values = ref<SettingsMap>({ ...DEFAULT_SETTINGS })
  const prefersContrast = ref(false)
  const settingsOpen = ref(false)
  const settingsSection = ref<SettingsSection>('general')
  const highContrast = computed(() =>
    values.value.high_contrast === 'auto'
      ? prefersContrast.value
      : values.value.high_contrast === 'true'
  )
  // high contrast is a dark theme
  const isDark = computed(() => values.value.theme !== 'light' || highContrast.value)
  const fontSize = computed(() => Number(values.value.editor_font_size) || 20)
  const colored = computed(() => values.value.colored_diacritics === 'true')

  /** Tell the main process whether automatic update checks are allowed. */
  function pushUpdateSetting(): void {
    void window.mizajAPI?.setAutoUpdateCheck(values.value.auto_update_check !== 'false')
  }

  function applyToDom(): void {
    const root = document.documentElement
    try {
      prefersContrast.value = window.matchMedia('(prefers-contrast: more)').matches
    } catch {
      /* no matchMedia */
    }
    root.classList.toggle('dark', isDark.value)
    root.classList.toggle('hc', highContrast.value)
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
    pushUpdateSetting()
  }

  /** Applies immediately (optimistic), then persists; rolls back on failure. */
  let updateSeq = 0
  async function update(patch: SettingsMap): Promise<void> {
    const seq = ++updateSeq
    const prev = values.value
    values.value = { ...prev, ...patch }
    applyToDom()
    try {
      const echo = await useApi().put<SettingsMap>('/api/settings', patch)
      // Only the newest request may overwrite local state: an older response would flip back a
      // control the user already changed again (rapid toggles). The newest echo contains
      // every earlier patch because the server applies requests in order.
      if (seq === updateSeq) values.value = { ...DEFAULT_SETTINGS, ...echo }
    } catch {
      if (seq === updateSeq) values.value = prev
    }
    applyToDom()
    pushUpdateSetting()
  }

  /** Ctrl+= / Ctrl+- / Ctrl+0: change the editor font size and persist it. */
  async function zoom(action: 'in' | 'out' | 'reset'): Promise<void> {
    const next = nextFontSize(fontSize.value, action)
    if (next !== fontSize.value) await update({ editor_font_size: String(next) })
  }

  /** Open the settings dialog, optionally on a given section (used by other panels). */
  function openSettings(section: SettingsSection = 'general'): void {
    settingsSection.value = (SETTINGS_SECTIONS as readonly string[]).includes(section)
      ? section
      : 'general'
    settingsOpen.value = true
  }
  function closeSettings(): void {
    settingsOpen.value = false
  }

  return {
    settingsOpen,
    settingsSection,
    openSettings,
    closeSettings,
    values,
    isDark,
    highContrast,
    fontSize,
    colored,
    load,
    update,
    applyToDom,
    zoom
  }
})
