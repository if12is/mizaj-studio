<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { copyText } from '@renderer/lib/native'
import { useEditorStore } from '@renderer/stores/editor'

interface Currency {
  code: string
  country: string
  name: string
}
const editor = useEditorStore()
const currencies = ref<Currency[]>([])
const amount = ref('')
const currency = ref('SAR')
const cas = ref('nominative')
const style = ref<'plain' | 'legal'>('legal')
const adjective = ref(true)
const spelling = ref("ma'a")
const minor = ref('words')
const gender = ref('m')
const result = ref<{ words: string; formula: string } | null>(null)
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'

onMounted(async () => {
  try {
    currencies.value = await useApi().get<Currency[]>('/api/legal/currencies', true)
  } catch {
    /* offline: leave empty */
  }
})

async function run(): Promise<void> {
  result.value = null
  try {
    result.value = await useApi().post('/api/legal/tafqeet', {
      amount: amount.value.trim(),
      currency: currency.value || null,
      case: cas.value,
      style: style.value,
      adjective: adjective.value,
      spelling: spelling.value,
      minor: minor.value,
      gender: gender.value
    })
  } catch {
    /* toast shown */
  }
}
const text = (): string =>
  result.value ? (style.value === 'legal' ? result.value.formula : result.value.words) : ''
const insert = (): void => editor.accessor?.insertText(text())
async function copy(): Promise<void> {
  if (await copyText(text())) notify('تم النسخ.', { kind: 'success', ms: 1500 })
  else notify('تعذر النسخ إلى الحافظة.')
}
</script>

<template>
  <div class="space-y-2 p-3 text-sm" data-testid="tafqeet-tool">
    <input
      v-model="amount"
      :class="field"
      class="w-full"
      aria-label="المبلغ، مثال: 1500.50"
      placeholder="المبلغ، مثال: 1500.50"
      data-testid="tafqeet-amount"
      @keydown.enter="run"
    />
    <select
      v-model="currency"
      :class="field"
      class="w-full"
      data-testid="tafqeet-currency"
      aria-label="العملة"
    >
      <option value="">بدون عملة (رقم فقط)</option>
      <option v-for="c in currencies" :key="c.code" :value="c.code">
        {{ c.name }} — {{ c.country }} ({{ c.code }})
      </option>
    </select>
    <div class="grid grid-cols-2 gap-2">
      <select v-model="cas" :class="field" data-testid="tafqeet-case" aria-label="حالة الإعراب">
        <option value="nominative">مرفوع</option>
        <option value="accusative">منصوب</option>
        <option value="genitive">مجرور</option>
      </select>
      <select v-model="style" :class="field" data-testid="tafqeet-style" aria-label="أسلوب الصياغة">
        <option value="legal">صيغة قانونية (فقط … لا غير)</option>
        <option value="plain">عادي</option>
      </select>
      <select v-model="spelling" :class="field" aria-label="رسم المئة">
        <option value="ma'a">مائة</option>
        <option value="mi'a">مئة</option>
      </select>
      <select v-model="minor" :class="field" aria-label="الكسور">
        <option value="words">الكسور بالحروف</option>
        <option value="fraction">الكسور كسراً</option>
      </select>
      <select v-if="!currency" v-model="gender" :class="field" aria-label="النوع">
        <option value="m">مذكر</option>
        <option value="f">مؤنث</option>
      </select>
      <label class="flex items-center gap-1"
        ><input v-model="adjective" type="checkbox" /> نعت العملة</label
      >
    </div>
    <button
      class="rounded bg-mizaj-emerald px-3 py-1 text-white"
      data-testid="tafqeet-run"
      @click="run"
    >
      تفقيط
    </button>
    <div v-if="result" class="space-y-2 rounded border p-2 dark:border-slate-600">
      <p class="font-editor text-lg" data-testid="tafqeet-result">{{ text() }}</p>
      <div class="flex gap-2">
        <button
          class="rounded bg-mizaj-emerald px-2 py-1 text-white"
          data-testid="tafqeet-insert"
          @click="insert"
        >
          إدراج في المستند
        </button>
        <button
          class="rounded border px-2 py-1 dark:border-slate-600"
          data-testid="tafqeet-copy"
          @click="copy"
        >
          نسخ
        </button>
      </div>
    </div>
  </div>
</template>
