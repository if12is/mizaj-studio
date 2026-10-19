import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { buildLegalIssues, type LegalIssue } from '@renderer/legal/issues'
import { useEditorStore } from './editor'

export const useLegalStore = defineStore('legal', () => {
  const issues = shallowRef<LegalIssue[]>([])
  const checked = ref(false)
  const running = ref(false)

  /** Run the four legal checks in parallel over the current text. */
  async function runChecks(): Promise<void> {
    const editor = useEditorStore()
    const acc = editor.accessor
    if (!acc) return
    const text = acc.getText()
    const api = useApi()
    running.value = true
    try {
      const body = { text }
      const [amounts, terms, clauses, glossary, refs] = await Promise.all([
        api.post<never>('/api/legal/check-amounts', body),
        api.post<never>('/api/legal/defined-terms', body),
        api.post<never>('/api/legal/clauses', body),
        api.post<never>('/api/legal/glossary/check', body),
        api.post<never>('/api/legal/check-refs', body)
      ])
      issues.value = buildLegalIssues(text, { amounts, terms, clauses, glossary, refs })
      checked.value = true
    } catch {
      /* error toast already shown */
    } finally {
      running.value = false
    }
  }

  function jump(i: LegalIssue): void {
    useEditorStore().accessor?.jumpTo(i.from, i.to)
  }

  /** Apply one suggested edit (verified against the current text), then re-check. */
  async function applyFix(i: LegalIssue): Promise<void> {
    if (!i.fix) return
    const ok = useEditorStore().accessor?.applyEdit(i.from, i.to, i.expected, i.fix.insert)
    if (!ok) {
      notify('تغيّر النص منذ الفحص؛ أعد الفحص ثم طبّق الاقتراح.', { kind: 'info' })
      return
    }
    await runChecks()
  }

  return { issues, checked, running, runChecks, jump, applyFix }
})
