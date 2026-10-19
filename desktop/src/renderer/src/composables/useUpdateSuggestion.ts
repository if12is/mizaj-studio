import { watch } from 'vue'
import { showActionToast } from './useActionToast'
import { useSettingsStore } from '@renderer/stores/settings'

const KEY = 'mizaj.updateSuggestShown'
export const SUGGEST_DELAY_MS = 6000

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
function remember(): void {
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* storage unavailable: it may be offered again next launch */
  }
}

/**
 * When automatic update checks are off, offer ONCE (gently, as a dismissible toast) to turn them
 * on. Never turns anything on by itself (opt-in rules in AGENTS.md section 5).
 */
export function useUpdateSuggestion(): void {
  const settings = useSettingsStore()
  let timer: ReturnType<typeof setTimeout> | null = null
  watch(
    () => settings.values.auto_update_check,
    (v) => {
      if (timer) clearTimeout(timer)
      timer = null
      if (v !== 'false' || seen()) return
      timer = setTimeout(() => {
        if (settings.values.auto_update_check !== 'false' || seen()) return
        remember()
        showActionToast({
          kind: 'info',
          title: 'تحديثات مِزَاج',
          text: 'التحقق التلقائي من التحديثات متوقف. هل تريد تفعيله؟ الاتصال الوحيد هو فحص إصدارات المشروع على GitHub، ويمكنك إيقافه من الإعدادات في أي وقت.',
          testid: 'update-suggest-toast',
          ms: 20_000,
          actions: [
            {
              label: 'تفعيل',
              primary: true,
              testid: 'update-suggest-enable',
              run: () => settings.update({ auto_update_check: 'true' })
            },
            { label: 'لاحقاً', testid: 'update-suggest-later', run: () => undefined }
          ]
        })
      }, SUGGEST_DELAY_MS)
    },
    { immediate: true }
  )
}
