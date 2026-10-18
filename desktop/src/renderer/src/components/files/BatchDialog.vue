<script setup lang="ts">
import { computed, onBeforeUnmount, reactive } from 'vue'
import ModalShell from './ModalShell.vue'
import {
  BATCH_FORMATS,
  BATCH_STATUS_LABEL,
  batchPercent,
  describeBatchError,
  isFinished,
  type BatchForm
} from '@renderer/files/batch'
import { openFolder, pickDirectory } from '@renderer/lib/native'
import { useBatchStore } from '@renderer/stores/batch'
import { useFileStore } from '@renderer/stores/fileio'
import { useSettingsStore } from '@renderer/stores/settings'

const files = useFileStore()
const batch = useBatchStore()
const settings = useSettingsStore()
const form = reactive<BatchForm>({
  input_dir: '',
  output_dir: '',
  mode: settings.values.engine_mode === 'accurate' ? 'accurate' : 'fast',
  level: (settings.values.tashkeel_level as BatchForm['level']) || 'full',
  formats: ['docx', 'txt', 'md', 'srt', 'epub'],
  recursive: true,
  on_exist: 'rename',
  track_changes: false
})
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'

const job = computed(() => batch.job)
const percent = computed(() => (job.value ? batchPercent(job.value) : 0))
const finished = computed(() => !!job.value && isFinished(job.value.status))

async function chooseIn(): Promise<void> {
  const p = await pickDirectory('مجلد الإدخال')
  if (p) form.input_dir = p
}
async function chooseOut(): Promise<void> {
  const p = await pickDirectory('مجلد الإخراج')
  if (p) form.output_dir = p
}
function toggleFormat(id: string, on: boolean): void {
  form.formats = on ? [...new Set([...form.formats, id])] : form.formats.filter((x) => x !== id)
}
function close(): void {
  batch.reset()
  files.batchOpen = false
}
onBeforeUnmount(() => batch.stopPolling())
</script>

<template>
  <ModalShell title="معالجة مجلد" testid="batch-dialog" @close="close">
    <div class="space-y-3 text-sm">
      <p class="text-xs text-slate-500">
        تُشكَّل كل الملفات المدعومة في مجلد الإدخال وتُكتب نسخ جديدة في مجلد الإخراج؛ لا تُعدَّل
        الملفات الأصلية أبداً.
      </p>
      <div class="grid grid-cols-[auto_1fr_auto] items-center gap-2">
        <span>مجلد الإدخال</span>
        <input
          v-model="form.input_dir"
          :class="field"
          dir="ltr"
          readonly
          aria-label="مجلد الإدخال"
          data-testid="batch-input-dir"
        />
        <button :class="btn" data-testid="batch-pick-input" @click="chooseIn">اختيار…</button>
        <span>مجلد الإخراج</span>
        <input
          v-model="form.output_dir"
          :class="field"
          dir="ltr"
          readonly
          aria-label="مجلد الإخراج"
          data-testid="batch-output-dir"
        />
        <button :class="btn" data-testid="batch-pick-output" @click="chooseOut">اختيار…</button>
      </div>
      <div class="grid grid-cols-2 items-center gap-2">
        <label for="b-mode">وضع المحرك</label>
        <select id="b-mode" v-model="form.mode" :class="field" data-testid="batch-mode">
          <option value="fast">سريع</option>
          <option value="accurate">دقيق</option>
        </select>
        <label for="b-level">مستوى التشكيل</label>
        <select id="b-level" v-model="form.level" :class="field" data-testid="batch-level">
          <option value="full">كامل</option>
          <option value="irab_only">أواخر الكلمات (الإعراب)</option>
          <option value="essential">إلزامي: أواخر الكلمات والتنوين والشدة</option>
          <option value="minimal">الحد الأدنى (فك اللبس)</option>
          <option value="legal">قانوني</option>
        </select>
        <label for="b-exist">إذا وُجد ملف بالاسم نفسه</label>
        <select id="b-exist" v-model="form.on_exist" :class="field" data-testid="batch-on-exist">
          <option value="rename">إعادة تسمية الجديد</option>
          <option value="skip">تخطّي</option>
          <option value="overwrite">استبدال</option>
        </select>
      </div>
      <fieldset>
        <legend class="mb-1 font-semibold">الصيغ</legend>
        <div class="flex flex-wrap gap-3">
          <label v-for="[id, label] in BATCH_FORMATS" :key="id" class="flex items-center gap-1">
            <input
              type="checkbox"
              :checked="form.formats.includes(id)"
              :data-testid="`batch-format-${id}`"
              @change="toggleFormat(id, ($event.target as HTMLInputElement).checked)"
            />
            {{ label }}
          </label>
        </div>
      </fieldset>
      <div class="flex flex-wrap gap-4">
        <label class="flex items-center gap-1">
          <input v-model="form.recursive" type="checkbox" data-testid="batch-recursive" />
          تضمين المجلدات الفرعية
        </label>
        <label class="flex items-center gap-1">
          <input v-model="form.track_changes" type="checkbox" data-testid="batch-track-changes" />
          تتبّع التغييرات في ملفات Word
        </label>
      </div>
      <p v-if="batch.error" class="text-red-500" role="alert" data-testid="batch-error">
        {{ batch.error }}
      </p>
      <div class="flex gap-2">
        <button
          class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
          :disabled="batch.starting || batch.running"
          data-testid="batch-start"
          @click="batch.start(form)"
        >
          ابدأ المعالجة
        </button>
        <button
          v-if="batch.running"
          :class="btn"
          data-testid="batch-cancel"
          @click="batch.cancel()"
        >
          إلغاء
        </button>
      </div>

      <section
        v-if="job"
        class="space-y-2 rounded border p-2 dark:border-slate-600"
        data-testid="batch-progress"
      >
        <p data-testid="batch-status" :data-status="job.status">
          {{ BATCH_STATUS_LABEL[job.status] }} — {{ job.done }} / {{ job.total }}
          <span class="text-xs text-slate-500">
            (نجح {{ job.succeeded }}، تُخطّي {{ job.skipped }}، أخطاء {{ job.errors.length }})
          </span>
        </p>
        <div
          class="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"
          role="progressbar"
          aria-label="تقدم المعالجة"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="percent"
        >
          <div class="h-full bg-mizaj-emerald" :style="{ width: percent + '%' }" />
        </div>
        <p v-if="job.current" class="truncate text-xs text-slate-500" dir="ltr">
          {{ job.current }}
        </p>
        <ul v-if="job.errors.length" class="space-y-1 text-red-500" data-testid="batch-errors">
          <li v-for="(e, i) in job.errors" :key="i" data-testid="batch-error-item">
            {{ describeBatchError(e) }}
          </li>
        </ul>
        <button
          v-if="finished"
          :class="btn"
          data-testid="batch-open-output"
          @click="openFolder(form.output_dir)"
        >
          فتح مجلد الإخراج
        </button>
      </section>
    </div>
  </ModalShell>
</template>
