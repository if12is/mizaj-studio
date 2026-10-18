<script setup lang="ts">
import { ref } from 'vue'
import { useApi } from '@renderer/api'
import { notify } from '@renderer/api/toast'
import { copyText } from '@renderer/lib/native'
import { useEditorStore } from '@renderer/stores/editor'

const editor = useEditorStore()
const today = new Date().toISOString().slice(0, 10)
const date = ref(today)
const calendar = ref('gregorian')
const adjust = ref(0)
const names = ref('gulf')
const spelling = ref("ma'a")
const cas = ref('nominative')
const dayName = ref(true)
const result = ref<{ words: string; warnings?: string[] } | null>(null)
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'

async function run(): Promise<void> {
  result.value = null
  try {
    result.value = await useApi().post('/api/legal/date-words', {
      date: date.value,
      calendar: calendar.value,
      hijri_adjust: Number(adjust.value),
      gregorian_names: names.value,
      spelling: spelling.value,
      case: cas.value,
      with_day_name: dayName.value
    })
  } catch {
    /* toast shown */
  }
}
const insert = (): void => {
  if (result.value) editor.accessor?.insertText(result.value.words)
}
async function copy(): Promise<void> {
  if (!result.value) return
  if (await copyText(result.value.words)) notify('تم النسخ.', { kind: 'success', ms: 1500 })
  else notify('تعذر النسخ إلى الحافظة.')
}
</script>

<template>
  <div class="space-y-2 p-3 text-sm" data-testid="date-tool">
    <input
      v-model="date"
      type="date"
      :class="field"
      class="w-full"
      aria-label="التاريخ"
      data-testid="date-input"
    />
    <div class="grid grid-cols-2 gap-2">
      <select v-model="calendar" :class="field" data-testid="date-calendar" aria-label="التقويم">
        <option value="gregorian">ميلادي</option>
        <option value="hijri">هجري</option>
      </select>
      <select
        v-model="adjust"
        :class="field"
        title="تعديل التقويم الهجري"
        aria-label="تعديل الهجري"
      >
        <option :value="-1">هجري −1</option>
        <option :value="0">هجري 0</option>
        <option :value="1">هجري +1</option>
      </select>
      <select v-model="names" :class="field" aria-label="أسماء الأشهر">
        <option value="gulf">أسماء الأشهر (الخليج)</option>
        <option value="levant">أسماء الأشهر (الشام)</option>
      </select>
      <select v-model="cas" :class="field" aria-label="حالة الإعراب">
        <option value="nominative">مرفوع</option>
        <option value="accusative">منصوب</option>
        <option value="genitive">مجرور</option>
      </select>
      <select v-model="spelling" :class="field" aria-label="رسم المئة">
        <option value="ma'a">مائة</option>
        <option value="mi'a">مئة</option>
      </select>
      <label class="flex items-center gap-1"
        ><input v-model="dayName" type="checkbox" /> اسم اليوم</label
      >
    </div>
    <button
      class="rounded bg-mizaj-emerald px-3 py-1 text-white"
      data-testid="date-run"
      @click="run"
    >
      كتابة التاريخ بالحروف
    </button>
    <div v-if="result" class="space-y-2 rounded border p-2 dark:border-slate-600">
      <p class="font-editor text-lg" data-testid="date-result">{{ result.words }}</p>
      <p v-for="w in result.warnings ?? []" :key="w" class="text-xs text-mizaj-amber">{{ w }}</p>
      <div class="flex gap-2">
        <button
          class="rounded bg-mizaj-emerald px-2 py-1 text-white"
          data-testid="date-insert"
          @click="insert"
        >
          إدراج في المستند
        </button>
        <button class="rounded border px-2 py-1 dark:border-slate-600" @click="copy">نسخ</button>
      </div>
    </div>
  </div>
</template>
