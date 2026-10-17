export const DATA_KINDS = ['dictionary', 'glossary', 'templates', 'settings'] as const
export type PackKind = (typeof DATA_KINDS)[number] | 'models'

export const KIND_LABEL: Record<string, string> = {
  dictionary: 'القاموس الشخصي',
  glossary: 'المعجم القانوني',
  templates: 'القوالب',
  settings: 'الإعدادات',
  models: 'النماذج',
  bundle: 'حزمة مجمّعة'
}

export const KIND_HELP: Record<string, string> = {
  dictionary: 'الكلمات المقفلة التي شكّلتها بنفسك',
  glossary: 'المصطلحات القانونية المشكولة',
  templates: 'قوالبك الخاصة (القوالب التعليمية المدمجة لا تُصدَّر إلا إن طلبت)',
  settings: 'الإعدادات القابلة للمشاركة فقط (الخط، المستوى…)'
}

const REASONS: Record<string, string> = {
  new: 'عنصر جديد',
  replaces_cache_entry: 'يستبدل تشكيلاً تلقائياً محفوظاً (لم تقفله أنت)',
  replaces_imported: 'يستبدل إدخالاً مستورداً سابقاً',
  identical: 'مطابق لما لديك',
  duplicate_in_pack: 'مكرر داخل الحزمة',
  not_arabic: 'ليس نصاً عربياً',
  base_letters_differ: 'حروفه الأساسية تختلف عن الكلمة (لا يُقبل تغيير الحروف)',
  no_diacritics: 'بلا حركات',
  quran_text: 'نص قرآني محمي ولا يُستورد',
  user_locked: 'لديك تشكيل مقفل مختلف لهذه الكلمة',
  differs_from_local: 'يختلف عن النسخة المحلية',
  private_setting: 'إعداد خاص لا يُستورد',
  invalid_value: 'قيمة غير صالحة'
}

export function reasonLabel(reason: string): string {
  if (reason.startsWith('invalid:')) return `غير صالح: ${reason.slice(8).trim()}`
  return REASONS[reason] ?? reason
}

export interface PlanItem {
  key: string
  action: 'add' | 'update' | 'conflict' | 'skip'
  reason: string
  incoming: unknown
  current: unknown
  options?: string[]
}

export interface PlanGroups {
  adds: PlanItem[]
  updates: PlanItem[]
  conflicts: PlanItem[]
  skips: PlanItem[]
}

export const GROUP_TITLE: Record<keyof PlanGroups, string> = {
  adds: 'إضافات جديدة',
  updates: 'تحديثات',
  conflicts: 'تعارضات تحتاج قرارك',
  skips: 'مُتخطّاة'
}

/** Short readable text for an incoming / current value of any pack kind. */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'string') return v
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['diacritized_form', 'diacritized', 'preview']) {
      if (typeof o[k] === 'string') return o[k] as string
    }
  }
  return JSON.stringify(v)
}

export type Choice = 'keep' | 'override' | 'duplicate'

/** Build the `decisions` body for /apply from the user's per-item choices. */
export function buildDecisions(
  plans: Record<string, PlanGroups>,
  choices: Record<string, Record<string, Choice>>
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [kind, g] of Object.entries(plans)) {
    for (const it of [...g.conflicts, ...g.updates]) {
      const c = choices[kind]?.[it.key]
      if (!c) continue
      if (it.action === 'update') {
        // updates apply by default: only an explicit "keep" needs sending
        if (c === 'keep') (out[kind] ??= {})[it.key] = 'keep'
      } else if (c !== 'keep') {
        ;(out[kind] ??= {})[it.key] = c
      }
    }
  }
  return out
}

export function summaryText(s: {
  adds: number
  updates: number
  conflicts: number
  skips: number
}): string {
  return `${s.adds} جديد، ${s.updates} تحديث، ${s.conflicts} تعارض، ${s.skips} مُتخطّى`
}

export function appliedText(
  a: Record<string, { added: number; updated: number; kept_local: number }>
): string {
  const parts = Object.entries(a).map(
    ([k, v]) =>
      `${KIND_LABEL[k] ?? k}: أُضيف ${v.added}، حُدّث ${v.updated}، أُبقي المحلي ${v.kept_local}`
  )
  return parts.join(' — ')
}
