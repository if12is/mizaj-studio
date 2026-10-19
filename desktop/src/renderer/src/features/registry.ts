/**
 * Feature registry: one place that says WHERE each optional tool/resource shows up in the UI.
 * New optional features add one entry here and call `announceFeature(id)` when they get enabled;
 * the «تم التفعيل» toast, the «أرني» spotlight and the «جديد» badge then work without further code.
 */
export interface FeatureInfo {
  /** Arabic name shown in the toast */
  title: string
  /** CSS selector of the exact button / menu item / area to point at */
  selector: string
  /** Selector to click first when `selector` is not in the DOM yet (e.g. a closed menu) */
  reveal?: string
  /** «شريط الأدوات ← …»: human readable location */
  where: string
  /** Arabic description shown in the spotlight tooltip */
  description: string
  /** badge «جديد» on the target until first use (default true) */
  badge?: boolean
}

export const FEATURES = {
  ocr: {
    title: 'التعرف الضوئي على الحروف (OCR)',
    selector: '[data-testid="file-import"]',
    reveal: '[data-testid="file-menu"]',
    where: 'ملف ← استيراد ملف…',
    description: 'استورد صورة أو PDF ممسوحاً من هنا ليُحوَّل إلى نص قابل للتحرير.'
  },
  languagetool: {
    title: 'LanguageTool',
    selector: '[data-testid="toolbar-spell"]',
    where: 'شريط الأدوات ← تدقيق إملائي',
    description: 'يضيف التدقيق النحوي من LanguageTool المحلي إلى نتائج التدقيق.'
  },
  quran: {
    title: 'نص القرآن الكريم',
    selector: '[data-testid="editor-host"]',
    where: 'المحرر ← حماية الآيات تلقائياً',
    description: 'الآيات القرآنية في نصك تُكتشف وتُحمى الآن من أي تعديل.',
    badge: false
  },
  spellDictionary: {
    title: 'قاموس الإملاء',
    selector: '[data-testid="toolbar-spell"]',
    where: 'شريط الأدوات ← تدقيق إملائي',
    description: 'يستخدم التدقيق الإملائي القاموس المثبّت.'
  },
  tashkeelModels: {
    title: 'نماذج التشكيل',
    selector: '[data-testid="toolbar-tashkeel"]',
    where: 'شريط الأدوات ← تشكيل',
    description: 'زر التشكيل يستخدم النماذج الجديدة.'
  },
  packs: {
    title: 'الحزم',
    selector: '[data-testid="toggle-legal-panel"]',
    where: 'شريط الأدوات ← أدوات قانونية',
    description: 'مصطلحات الحزمة وعباراتها الجاهزة تجدها في الأدوات القانونية.'
  },
  // ---- core controls the guided tour points at (no «جديد» badge, never enabled/disabled)
  fileMenu: {
    title: 'قائمة الملف',
    selector: '[data-testid="file-menu"]',
    where: 'قائمة «ملف» أعلى المحرر',
    description: 'من هنا تستورد ملف Word أو PDF أو صورة، وتصدّر مستندك.',
    badge: false
  },
  tashkeel: {
    title: 'التشكيل',
    selector: '[data-testid="toolbar-tashkeel"]',
    where: 'شريط الأدوات ← تشكيل',
    description: 'يشكّل المحدد أو كامل المقال.',
    badge: false
  },
  proofread: {
    title: 'تدقيق ثم تشكيل',
    selector: '[data-testid="toolbar-proofread"]',
    where: 'شريط الأدوات ← تدقيق ثم تشكيل',
    description: 'يصحّح الإملاء والترقيم أولاً ثم يشكّل.',
    badge: false
  },
  history: {
    title: 'سجل التعديلات',
    selector: '[data-testid="toolbar-history"]',
    where: 'شريط الأدوات ← سجل التعديلات',
    description: 'يحفظ نسخاً من عملك لتعود إلى أي منها.',
    badge: false
  },
  gemini: {
    title: 'مساعد Gemini',
    selector: '[data-testid="toggle-gemini-panel"]',
    where: 'شريط الأدوات ← اسأل عن المستند',
    description: 'اسأل عن المستند أو عن كلمة بعينها من هذه اللوحة.'
  }
} as const satisfies Record<string, FeatureInfo>

export type FeatureId = keyof typeof FEATURES

/** Resource catalog id (backend/app/resources/catalog.json) -> feature. No entry: no UI to point at. */
export const RESOURCE_FEATURE: Record<string, FeatureId> = {
  'tanzil-quran-uthmani': 'quran',
  'ayaspell-ar': 'spellDictionary',
  'catt-eo-onnx': 'tashkeelModels',
  'mizaj-legal-terms': 'packs',
  'mizaj-names-eg-gulf-levant': 'packs',
  'mizaj-official-phrases': 'packs'
}

export const featureOf = (resourceId: string): FeatureId | null =>
  RESOURCE_FEATURE[resourceId] ?? null

/** Toast body: «تجده الآن في: شريط الأدوات ← …» */
export const locationText = (id: FeatureId): string => `تجده الآن في: ${FEATURES[id].where}`

export type FeatureStatus = 'running' | 'enabled' | 'off' | 'missing'
export const STATUS_LABEL: Record<FeatureStatus, string> = {
  running: 'يعمل',
  enabled: 'مفعّل',
  off: 'مثبّت وغير مفعّل',
  missing: 'غير مثبّت'
}

/** Catalog resource: downloading -> يعمل, installed -> مفعّل, otherwise غير مثبّت. */
export function resourceStatus(r: {
  installed: unknown
  job: { status: string } | null
}): FeatureStatus {
  if (r.job && (r.job.status === 'queued' || r.job.status === 'running')) return 'running'
  return r.installed ? 'enabled' : 'missing'
}

/** Local tool: not detected -> غير مثبّت; detected and switched on -> يعمل; detected but off. */
export function toolStatus(detected: boolean | undefined, on: boolean): FeatureStatus {
  if (!detected) return 'missing'
  return on ? 'running' : 'off'
}
