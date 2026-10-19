import type { FeatureId } from '@renderer/features/registry'

/**
 * The first-run guided tour: five short steps. A step with a `feature` points at that button
 * through the feature registry (the same selector the «أرني» spotlight uses); a step without
 * one (Ctrl+K is a key, not a button) is shown centered.
 */
export interface TourStep {
  id: string
  title: string
  text: string
  feature?: FeatureId
  /** shortcut shown as a key cap under the text (LTR) */
  kbd?: string
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'document',
    title: 'أنشئ مستنداً أو استورد ملفاً',
    text: 'من قائمة «ملف» تستورد ملف Word أو PDF أو صورة، أو أنشئ مستنداً جديداً من الشريط الجانبي. كل شيء يُحفظ تلقائياً على جهازك.',
    feature: 'fileMenu'
  },
  {
    id: 'tashkeel',
    title: 'شكّل النص',
    text: 'اضغط «تشكيل» لتشكيل المحدد أو كامل المقال. تراجع أي تغيير بـ Ctrl+Z.',
    feature: 'tashkeel',
    kbd: 'Ctrl+Shift+T'
  },
  {
    id: 'proofread',
    title: 'دقّق ثم شكّل',
    text: '«تدقيق ثم تشكيل» يصحّح الإملاء والترقيم أولاً ثم يشكّل، فتأتي النتيجة أدق. لا يُغيَّر حرف دون موافقتك.',
    feature: 'proofread'
  },
  {
    id: 'palette',
    title: 'كل شيء بضغطة واحدة',
    text: 'اضغط Ctrl+K للبحث عن أي أمر أو إعداد أو مستند، أو عن كلمة داخل محتوى كل ملفاتك.',
    kbd: 'Ctrl+K'
  },
  {
    id: 'history',
    title: 'السجل والدليل',
    text: 'سجل التعديلات يحفظ نسخاً من عملك لتعود إلى أي نسخة. وللمساعدة في أي وقت اضغط F1 لفتح الدليل.',
    feature: 'history',
    kbd: 'F1'
  }
]
