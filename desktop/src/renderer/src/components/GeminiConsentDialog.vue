<script setup lang="ts">
import { ref } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { useGeminiStore } from '@renderer/stores/gemini'

const gemini = useGeminiStore()
const el = ref<HTMLElement | null>(null)
useFocusTrap(el, () => void gemini.answerConsent(false))
</script>

<template>
  <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
    <div
      ref="el"
      class="w-[34rem] max-w-[95vw] rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="gemini-consent-title"
      data-testid="gemini-consent"
    >
      <h2 id="gemini-consent-title" class="mb-2 text-lg font-bold">إشعار قبل استخدام Gemini</h2>
      <ul class="mb-3 list-disc space-y-1 pr-5 text-sm">
        <li>
          عند طرح سؤال، يُرسَل <b>النص المحدد أو مقتطف من المستند</b> مع سؤالك إلى Google (Gemini).
        </li>
        <li>لا يُرسَل أي شيء آخر، ولا يُرسَل شيء إطلاقاً ما لم تطرح سؤالاً بنفسك.</li>
        <li>
          المساعد يقترح أو يؤكد شكّاً فقط؛ لا يعدّل مستندك أبداً، وأنت من يقرر تطبيق أي اقتراح.
        </li>
        <li>تخضع البيانات المرسلة لشروط Google وسياسة الخصوصية الخاصة بحسابك أو مفتاحك.</li>
      </ul>
      <div class="flex justify-end gap-2">
        <button
          class="rounded border px-3 py-1 dark:border-slate-600"
          data-testid="gemini-consent-decline"
          @click="gemini.answerConsent(false)"
        >
          لا، إلغاء
        </button>
        <button
          class="rounded bg-mizaj-emerald px-3 py-1 text-white"
          data-testid="gemini-consent-accept"
          @click="gemini.answerConsent(true)"
        >
          أوافق وأتابع
        </button>
      </div>
    </div>
  </div>
</template>
