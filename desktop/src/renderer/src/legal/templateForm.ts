export type VarType = 'text' | 'party' | 'money' | 'date' | 'number' | 'choice'

export interface TemplateVar {
  name: string
  type: VarType
  required?: boolean
  label?: string
  default?: unknown
  choices?: string[]
  currency?: string
  calendar?: 'gregorian' | 'hijri'
}

export const PARTY_FIELDS = ['name', 'role', 'id_number', 'address', 'nationality'] as const
export type PartyField = (typeof PARTY_FIELDS)[number]
export type PartyState = Record<PartyField, string>
export type FormState = Record<string, string | PartyState>

export const PARTY_LABELS: Record<PartyField, string> = {
  name: 'الاسم',
  role: 'الصفة',
  id_number: 'رقم الهوية',
  address: 'العنوان',
  nationality: 'الجنسية'
}

const emptyParty = (): PartyState => ({
  name: '',
  role: '',
  id_number: '',
  address: '',
  nationality: ''
})

/** Form state with defaults filled in (a party default may be an object). */
export function initialFormState(vars: TemplateVar[]): FormState {
  const s: FormState = {}
  for (const v of vars) {
    if (v.type === 'party') {
      const d = (v.default && typeof v.default === 'object' ? v.default : {}) as Partial<PartyState>
      s[v.name] = { ...emptyParty(), ...d }
    } else {
      s[v.name] = v.default === undefined || v.default === null ? '' : String(v.default)
    }
  }
  return s
}

/** Values object for /render: empty fields are omitted so "required" is reported by the server. */
export function buildValues(vars: TemplateVar[], form: FormState): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const v of vars) {
    const raw = form[v.name]
    if (v.type === 'party') {
      const p = (raw ?? emptyParty()) as PartyState
      const o: Record<string, string> = {}
      for (const f of PARTY_FIELDS) if (p[f]?.trim()) o[f] = p[f].trim()
      if (Object.keys(o).length) out[v.name] = o
    } else {
      const t = String(raw ?? '').trim()
      if (t) out[v.name] = t
    }
  }
  return out
}

const CODE_AR: Record<string, string> = {
  missing: 'هذا الحقل مطلوب',
  invalid_amount: 'مبلغ غير صالح',
  invalid_party: 'يلزم اسم الطرف على الأقل',
  not_party: 'قيمة الطرف غير صالحة',
  invalid_date: 'تاريخ غير صالح',
  invalid_number: 'رقم غير صالح',
  invalid_choice: 'اختيار غير صالح'
}

export interface RenderError {
  var: string
  code: string
  message: string
}

/** variable name -> Arabic message (first error per variable). */
export function errorMap(errors: RenderError[]): Record<string, string> {
  const m: Record<string, string> = {}
  for (const e of errors) if (!(e.var in m)) m[e.var] = CODE_AR[e.code] ?? e.message
  return m
}

/** Editor rows <-> API vars (choices as comma-separated text). */
export interface VarRow {
  name: string
  type: VarType
  required: boolean
  label: string
  default: string
  choices: string
  currency: string
}

export function varsToRows(vars: TemplateVar[]): VarRow[] {
  return vars.map((v) => ({
    name: v.name,
    type: v.type,
    required: v.required !== false,
    label: v.label ?? '',
    default:
      v.default === undefined || v.default === null || typeof v.default === 'object'
        ? ''
        : String(v.default),
    choices: (v.choices ?? []).join('، '),
    currency: v.currency ?? ''
  }))
}

export function rowsToVars(rows: VarRow[]): TemplateVar[] {
  return rows
    .filter((r) => r.name.trim())
    .map((r) => {
      const v: TemplateVar = { name: r.name.trim(), type: r.type, required: r.required }
      if (r.label.trim()) v.label = r.label.trim()
      if (r.default.trim()) v.default = r.default.trim()
      if (r.type === 'choice') {
        v.choices = r.choices
          .split(/[,،]/)
          .map((c) => c.trim())
          .filter(Boolean)
      }
      if (r.type === 'money' && r.currency.trim()) v.currency = r.currency.trim().toUpperCase()
      return v
    })
}
