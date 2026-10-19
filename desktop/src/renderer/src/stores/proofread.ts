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
import {
  AUTO_BASE_KEY,
  autoAccepted,
  autoBaseEnabled,
  countCategories,
  emptyCounts,
  isBase,
  type CategoryCounts,
  type OneStepSummary
} from '@renderer/proofread/oneStep'

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
  /** «تدقيق وتشكيل» in one step: base-letter fixes accepted without the review dialog */
  const autoBase = computed(() => autoBaseEnabled(settings.values[AUTO_BASE_KEY]))
  /** the ONE summary shown when a one-step run ends (null = hidden) */
  const summary = ref<OneStepSummary | null>(null)
  /** what the last review applied, per category (read by the one-step flow) */
  let lastApplied: CategoryCounts = emptyCounts()
  /** bumped by the summary's «مراجعة المشكوك فيه»; the editor pane starts the review */
  const reviewRequest = ref(0)

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
    isExplicit: boolean,
    preset?: (items: readonly ProofItem[]) => Record<string, Decision>
  ): Promise<ReviewResult> {
    load(res, t, from)
    if (preset) decisions.value = preset(res.items)
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
      lastApplied = countCategories(items.value.filter((i) => decisions.value[i.id] === 'accept'))
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

  /**
   * «تدقيق وتشكيل» step 1: proofread with every category and apply per the policy. Returns the
   * applied counts and whether tashkeel should follow, or null when the user cancelled (or the
   * edit could not be applied). Punctuation is applied directly; hamza/spelling/ya are applied
   * directly only with the setting ON, otherwise the review dialog opens with punctuation
   * pre-accepted and the base-letter items left for the user.
   */
  async function oneStepProofread(): Promise<{ fixed: CategoryCounts; run: boolean } | null> {
    if (open.value) return null
    const sel = editor.accessor?.selectionInfo()
    if (!sel || !sel.text.trim()) return { fixed: emptyCounts(), run: true }
    loading.value = true
    const res = await fetchProposals(sel.text)
    loading.value = false
    if (!res) {
      notify('تعذر التدقيق الآن؛ سيُشكَّل النص كما هو.', { kind: 'info' })
      return { fixed: emptyCounts(), run: true }
    }
    const direct = autoAccepted(res.items, autoBase.value)
    const needsReview = res.items.some((i) => isBase(i.category) && !direct.includes(i))
    if (!needsReview) {
      const dec: Record<string, Decision> = Object.fromEntries(direct.map((i) => [i.id, 'accept']))
      const ok = applyEditsToEditor(acceptedEdits(res.items, dec, sel.from), EVENT_LABELS.oneStep)
      return ok ? { fixed: countCategories(direct), run: true } : null
    }
    const preset = (its: readonly ProofItem[]): Record<string, Decision> =>
      Object.fromEntries(its.filter((i) => !isBase(i.category)).map((i) => [i.id, 'accept']))
    lastApplied = emptyCounts()
    const r = await review(res, sel.text, sel.from, true, preset)
    if (r === 'cancel') return null
    if (r === 'skip_run') {
      // the dialog applied nothing: punctuation still goes in directly
      const punct = res.items.filter((i) => !isBase(i.category))
      if (punct.length && !applyEditsToEditor(autoEdits(punct, sel.from), EVENT_LABELS.autoPunct))
        return null
      return { fixed: countCategories(punct), run: true }
    }
    return { fixed: lastApplied, run: r === 'apply_run' }
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
    autoBase,
    summary,
    reviewRequest,
    gate,
    oneStepProofread,
    finish,
    decide,
    choose,
    decideGroup,
    setYaStyle
  }
})
