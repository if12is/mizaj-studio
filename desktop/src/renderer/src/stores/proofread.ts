import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { useEditorStore } from './editor'
import { recordEvent } from './history'
import { EVENT_LABELS, acceptedLabel } from '@renderer/history/logic'
import { useSettingsStore } from './settings'
import {
  acceptedEdits,
  autoEdits,
  countByDecision,
  groupItems,
  normalizeMode,
  normalizeYaStyle,
  setGroup,
  type BeforeTashkeelMode,
  type Decision,
  type ProofCategory,
  type ProofItem,
  type ProofResponse,
  type ReviewResult,
  type YaStyle
} from '@renderer/proofread/model'

/** Texts above this size skip the automatic gate (the toolbar button still works). */
const GATE_MAX_CHARS = 1_500_000

/**
 * «تدقيق ثم تشكيل»: proofreading proposals are reviewed BEFORE the tashkeel run, so the engine
 * diacritizes the corrected spelling. Proposals are suggestions; only accepted items are applied.
 */
export const useProofreadStore = defineStore('proofread', () => {
  const settings = useSettingsStore()
  const editor = useEditorStore()

  const open = ref(false)
  const loading = ref(false)
  const items = shallowRef<ProofItem[]>([])
  const text = ref('')
  const base = ref(0)
  const decisions = ref<Record<string, Decision>>({})
  const overrides = ref<Record<string, string>>({})
  const truncated = ref(false)
  /** true when the review was opened by the explicit «تدقيق ثم تشكيل» button */
  const explicit = ref(false)
  let resolver: ((r: ReviewResult) => void) | null = null

  const mode = computed<BeforeTashkeelMode>(() =>
    normalizeMode(settings.values.proofread_before_tashkeel)
  )
  const yaStyle = computed<YaStyle>(() => normalizeYaStyle(settings.values.ya_style))
  const groups = computed(() => groupItems(items.value))
  const acceptedCount = computed(() => countByDecision(items.value, decisions.value, 'accept'))

  async function fetchProposals(
    t: string,
    categories?: ProofCategory[]
  ): Promise<ProofResponse | null> {
    try {
      return await useApi().request<ProofResponse>(
        'POST',
        '/api/proofread',
        { text: t, ya_style: yaStyle.value, ...(categories ? { categories } : {}) },
        true
      )
    } catch {
      return null // the backend being busy or absent must never block tashkeel
    }
  }

  function applyEditsToEditor(edits: ReturnType<typeof acceptedEdits>, label?: string): boolean {
    if (!edits.length) return true
    const before = editor.accessor?.getText()
    const ok = editor.accessor?.applyEdits(edits) ?? false
    if (!ok) notify('تغيّر النص أثناء المراجعة؛ أعد التدقيق.', { kind: 'info' })
    else {
      recordEvent(EVENT_LABELS.beforeProofread, before)
      recordEvent(label ?? acceptedLabel(edits.length))
    }
    return ok
  }

  function reset(): void {
    items.value = []
    decisions.value = {}
    overrides.value = {}
    text.value = ''
    truncated.value = false
  }

  function load(res: ProofResponse, t: string, from: number): void {
    items.value = res.items
    text.value = t
    base.value = from
    decisions.value = {}
    overrides.value = {}
    truncated.value = res.truncated
  }

  /** Re-run the proposals for the same text (after the ي/ى style changed). */
  async function refresh(): Promise<void> {
    const t = text.value
    loading.value = true
    const res = await fetchProposals(t)
    loading.value = false
    if (res) load(res, t, base.value)
  }

  /** Show the review panel and wait for the user's choice. */
  function review(
    res: ProofResponse,
    t: string,
    from: number,
    isExplicit: boolean
  ): Promise<ReviewResult> {
    load(res, t, from)
    explicit.value = isExplicit
    open.value = true
    return new Promise<ReviewResult>((resolve) => {
      resolver = resolve
    })
  }

  function finish(result: ReviewResult): void {
    const r = resolver
    resolver = null
    if (result === 'apply_run' || result === 'apply_only') {
      const ok = applyEditsToEditor(
        acceptedEdits(items.value, decisions.value, base.value, overrides.value)
      )
      if (!ok) result = 'cancel'
      else if (acceptedCount.value)
        editor.announce(`تم تطبيق ${acceptedCount.value} تصحيحاً قبل التشكيل`)
    }
    open.value = false
    reset()
    r?.(result)
  }

  /**
   * Called at the start of a tashkeel run. Returns whether the run should continue.
   * `force` (the toolbar button) always shows the review panel, whatever the setting.
   */
  async function gate(force = false): Promise<boolean> {
    if (open.value) return false
    const m = mode.value
    if (!force && m === 'off') return true
    const sel = editor.accessor?.selectionInfo()
    if (!sel || !sel.text.trim()) return true
    if (!force && sel.text.length > GATE_MAX_CHARS) return true
    loading.value = true
    const res = await fetchProposals(sel.text)
    loading.value = false
    if (!res) {
      if (force) notify('تعذر التدقيق الآن؛ سيُشكَّل النص كما هو.', { kind: 'info' })
      return true
    }
    if (!force && m === 'auto_punct') {
      // punctuation only, applied without asking; base letters are never touched silently
      const edits = autoEdits(res.items, sel.from)
      const left = res.items.filter((i) => i.category !== 'punctuation').length
      if (edits.length && applyEditsToEditor(edits, EVENT_LABELS.autoPunct)) {
        notify(
          `طُبّق ${edits.length} تصحيح ترقيم قبل التشكيل` +
            (left ? `، وبقي ${left} اقتراح للمراجعة (زر «تدقيق ثم تشكيل»).` : '.'),
          { kind: 'info' }
        )
      } else if (left) {
        notify(`${left} اقتراح إملائي للمراجعة (زر «تدقيق ثم تشكيل»).`, { kind: 'info' })
      }
      return true
    }
    if (!res.items.length && !force) return true
    const r = await review(res, sel.text, sel.from, force)
    return r === 'apply_run' || r === 'skip_run'
  }

  function decide(id: string, d: Decision): void {
    decisions.value = { ...decisions.value, [id]: d }
  }
  function choose(id: string, replacement: string): void {
    overrides.value = { ...overrides.value, [id]: replacement }
    decide(id, 'accept')
  }
  function decideGroup(category: ProofCategory, d: Decision): void {
    decisions.value = setGroup(decisions.value, items.value, category, d)
  }
  async function setYaStyle(v: YaStyle): Promise<void> {
    await settings.update({ ya_style: v })
    await refresh()
  }

  return {
    open,
    loading,
    items,
    text,
    decisions,
    overrides,
    truncated,
    explicit,
    mode,
    yaStyle,
    groups,
    acceptedCount,
    gate,
    finish,
    decide,
    choose,
    decideGroup,
    setYaStyle
  }
})
