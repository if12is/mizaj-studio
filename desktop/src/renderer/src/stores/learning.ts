import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { ApiError } from '@renderer/api/client'
import { notify } from '@renderer/api/toast'
import { repeatEdits, type WordCorrection } from '@renderer/editor/learning'
import { useDictionaryStore } from './dictionary'
import { useEditorStore } from './editor'
import { recordEvent } from './history'
import { useProjectsStore } from './projects'

export interface LearnPrompt {
  bare: string
  form: string
  /** other occurrences of the same base letters that the form could be applied to */
  repeats: number
}

/**
 * «حفظ هذا التشكيل؟»: after the user changes one word's marks by hand, offer to remember it
 * (personal dictionary) or to apply it to the other occurrences in this file. Non-blocking;
 * each word is offered at most once per session.
 */
export const useLearningStore = defineStore('learning', () => {
  const prompt = ref<LearnPrompt | null>(null)
  const offered = new Set<string>()

  function countRepeats(bare: string, form: string): number {
    const text = useEditorStore().accessor?.getText() ?? ''
    return repeatEdits(text, bare, form).words
  }

  function offer(c: WordCorrection): void {
    const cur = prompt.value
    if (cur && cur.bare === c.bare) {
      // the user is still typing marks on the word being offered: keep the prompt current
      prompt.value = { bare: c.bare, form: c.form, repeats: countRepeats(c.bare, c.form) }
      return
    }
    if (offered.has(c.bare)) return
    offered.add(c.bare)
    prompt.value = { bare: c.bare, form: c.form, repeats: countRepeats(c.bare, c.form) }
  }

  function dismiss(): void {
    prompt.value = null
  }

  async function saveToDictionary(): Promise<void> {
    const p = prompt.value
    if (!p) return
    prompt.value = null
    const api = useApi()
    try {
      await api.request(
        'POST',
        '/api/dictionary',
        { word_or_phrase: p.bare, diacritized_form: p.form },
        true
      )
      notify('تم حفظ الكلمة في قاموسك.', { kind: 'success' })
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // the user chose this form explicitly: update the existing entry
        const dict = useDictionaryStore()
        try {
          dict.query = p.bare
          await dict.load()
          const entry = dict.entries.find((x) => x.word_or_phrase === p.bare)
          if (entry) {
            await dict.update(entry.id, p.form)
            notify('تم تحديث الكلمة في قاموسك.', { kind: 'success' })
          }
        } catch {
          /* toast already shown */
        } finally {
          dict.query = ''
        }
      } else if (e instanceof ApiError) notify(e.messageAr)
    }
  }

  /** Apply the form to the other occurrences (one undo step, one history event). */
  function applyToRepeats(): number {
    const p = prompt.value
    const editor = useEditorStore()
    const acc = editor.accessor
    if (!p || !acc) return 0
    prompt.value = null
    const before = acc.getText()
    const { edits, words } = repeatEdits(before, p.bare, p.form)
    if (!edits.length) return 0
    const ok = acc.applyEdits(
      edits.map((e) => ({
        from: e.from,
        to: e.to,
        expected: before.slice(e.from, e.to),
        insert: e.insert
      }))
    )
    if (!ok) {
      notify('تغيّر النص؛ أعد المحاولة.', { kind: 'info' })
      return 0
    }
    recordEvent('قبل تعميم تشكيل كلمة', before)
    recordEvent(`تعميم تشكيل كلمة (${words})`)
    editor.addManualEdits(useProjectsStore().currentDocument?.id ?? 0, words, p.bare)
    editor.announce(`طُبّق التشكيل على ${words} تكراراً`)
    return words
  }

  /** forget what was offered (tests / new session) */
  function resetSession(): void {
    offered.clear()
    prompt.value = null
  }

  return { prompt, offer, dismiss, saveToDictionary, applyToRepeats, resetSession }
})
