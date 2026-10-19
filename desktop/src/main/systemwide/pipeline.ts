import { countArabicWords, hasArabic, stripMarks } from './arabic'

/**
 * The four operations of «مِزَاج في أي برنامج» as pure pipelines over injected backend calls.
 *
 *   proofread    -> hamza / spelling / final ya          (/api/proofread, categories filter)
 *   punctuation  -> punctuation spacing and marks only   (/api/proofread, categories filter)
 *   tashkeel     -> diacritics only                       (/api/tashkeel)
 *   all          -> proofread, then punctuation, then tashkeel, in that order
 *
 * The user's explicit action (pressing the shortcut / a button) is the consent for the letter
 * changes of the first two; tashkeel can never change a base letter (checked here, not trusted).
 */

export const OP_IDS = ['proofread', 'punctuation', 'tashkeel', 'all'] as const
export type OpId = (typeof OP_IDS)[number]

export const OP_LABEL_AR: Record<OpId, string> = {
  proofread: 'تدقيق إملائي',
  punctuation: 'ترقيم',
  tashkeel: 'تشكيل',
  all: 'الكل'
}

export type ProofreadCategory = 'hamza' | 'spelling' | 'ya' | 'punctuation'
export const SPELLING_CATEGORIES: readonly ProofreadCategory[] = ['hamza', 'spelling', 'ya']
export const PUNCTUATION_CATEGORIES: readonly ProofreadCategory[] = ['punctuation']

/** Under this many words the diacritization context is weak (shown as a warning, never blocks). */
export const SHORT_TEXT_WORDS = 4
/** A selection longer than this is refused (the backend limit is far higher; this keeps the UI snappy). */
export const MAX_SELECTION_CHARS = 200_000

export interface ProofreadItem {
  start: number
  end: number
  original: string
  replacement: string
  category: ProofreadCategory
}

export interface PipelineDeps {
  proofread(
    text: string,
    categories: readonly ProofreadCategory[]
  ): Promise<{ items: ProofreadItem[] }>
  apply(
    text: string,
    items: ProofreadItem[]
  ): Promise<{ text: string; applied: number; skipped: number }>
  tashkeel(text: string): Promise<{ text: string }>
}

export type WarningCode = 'short_text' | 'tashkeel_base_changed' | 'stale_items'

export const WARNING_AR: Record<WarningCode, string> = {
  short_text:
    'النص قصير (أقل من 4 كلمات): سياق التشكيل ضعيف، وقد تكون الحركات أقل دقة. حدّد جملة أو فقرة كاملة للحصول على نتيجة أفضل.',
  tashkeel_base_changed: 'رفض مِزَاج نتيجة التشكيل لأنها غيّرت حروفاً أساسية. لم يُغيَّر النص.',
  stale_items: 'تعذّر تطبيق بعض التصحيحات لأن النص تغيّر أثناء المعالجة؛ تُركت كما هي.'
}

export interface PipelineResult {
  text: string
  warnings: WarningCode[]
  /** applied proofreading items per step (for the status line) */
  applied: { proofread: number; punctuation: number }
  tashkeelRan: boolean
}

export class PipelineError extends Error {
  constructor(
    public readonly code: 'empty' | 'no_arabic' | 'too_long',
    public readonly messageAr: string
  ) {
    super(code)
    this.name = 'PipelineError'
  }
}

export const PIPELINE_ERRORS_AR = {
  empty: 'لم يُنسخ أي نص محدد. حدّد نصاً ثم اضغط الاختصار.',
  no_arabic: 'لا يوجد نص عربي في التحديد.',
  too_long: `التحديد طويل جداً (أكثر من ${MAX_SELECTION_CHARS.toLocaleString('en-US')} حرف). حدّد جزءاً أصغر.`
} as const

export function checkSelection(text: string): void {
  if (!text || !/\S/.test(text)) throw new PipelineError('empty', PIPELINE_ERRORS_AR.empty)
  if (text.length > MAX_SELECTION_CHARS)
    throw new PipelineError('too_long', PIPELINE_ERRORS_AR.too_long)
  if (!hasArabic(text)) throw new PipelineError('no_arabic', PIPELINE_ERRORS_AR.no_arabic)
}

/** Which operations include a tashkeel step. */
export const opUsesTashkeel = (op: OpId): boolean => op === 'tashkeel' || op === 'all'

async function proofreadStep(
  text: string,
  categories: readonly ProofreadCategory[],
  deps: PipelineDeps
): Promise<{ text: string; applied: number; stale: boolean }> {
  const { items } = await deps.proofread(text, categories)
  // defence in depth: whatever the backend returns, only the requested categories are applied
  const wanted = items.filter(
    (i) => categories.includes(i.category) && i.original !== i.replacement
  )
  if (!wanted.length) return { text, applied: 0, stale: false }
  const r = await deps.apply(text, wanted)
  return { text: r.text, applied: r.applied, stale: r.skipped > 0 }
}

export async function runOp(op: OpId, text: string, deps: PipelineDeps): Promise<PipelineResult> {
  checkSelection(text)
  const warnings: WarningCode[] = []
  const applied = { proofread: 0, punctuation: 0 }
  let cur = text
  let stale = false

  if (op === 'proofread' || op === 'all') {
    const r = await proofreadStep(cur, SPELLING_CATEGORIES, deps)
    cur = r.text
    applied.proofread = r.applied
    stale ||= r.stale
  }
  if (op === 'punctuation' || op === 'all') {
    const r = await proofreadStep(cur, PUNCTUATION_CATEGORIES, deps)
    cur = r.text
    applied.punctuation = r.applied
    stale ||= r.stale
  }
  let tashkeelRan = false
  if (opUsesTashkeel(op)) {
    if (countArabicWords(text) < SHORT_TEXT_WORDS) warnings.push('short_text')
    const t = await deps.tashkeel(cur)
    // tashkeel may only add / change marks: a base-letter difference means the result is refused
    if (stripMarks(t.text) !== stripMarks(cur)) warnings.push('tashkeel_base_changed')
    else {
      cur = t.text
      tashkeelRan = true
    }
  }
  if (stale) warnings.push('stale_items')
  return { text: cur, warnings, applied, tashkeelRan }
}
