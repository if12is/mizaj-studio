<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useApi } from '@renderer/api'
import { ApiError } from '@renderer/api/client'
import { openExternal, pickOpenPath } from '@renderer/lib/native'
import { useSettingsStore } from '@renderer/stores/settings'

interface QuranStatus {
  installed: boolean
  texts: Record<string, { path: string }>
  attribution: string
  attribution_ar: string
  license: string
  license_url: string
  download_page: string
  download_kinds: string[]
  verses: number
  ready: boolean
}

const settings = useSettingsStore()
const status = ref<QuranStatus | null>(null)
const busy = ref(false)
const accepted = ref(false)
const kind = ref('uthmani')
const message = ref<{ ok: boolean; text: string } | null>(null)
const KINDS: [string, string][] = [
  ['uthmani', 'الرسم العثماني'],
  ['simple-clean', 'إملائي مبسّط (للمطابقة)'],
  ['simple', 'إملائي'],
  ['simple-enhanced', 'إملائي مُحسَّن'],
  ['uthmani-min', 'عثماني مختصر'],
  ['simple-min', 'إملائي مختصر']
]
const online = computed(() => settings.values.online_resources === 'true')
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'

async function load(): Promise<void> {
  try {
    status.value = await useApi().get<QuranStatus>('/api/quran/status', true)
  } catch {
    status.value = null
  }
}
onMounted(() => void load())

const errText = (e: unknown): string =>
  e instanceof ApiError
    ? e.errorCode === 'ERR_ONLINE_DISABLED'
      ? 'التنزيل معطّل؛ فعّل «تنزيل الموارد المجانية العامة» من تبويب الاتصال.'
      : e.messageAr
    : 'تعذرت العملية.'

async function download(): Promise<void> {
  busy.value = true
  message.value = null
  try {
    status.value = await useApi().request<QuranStatus>('POST', '/api/quran/download', {}, true)
    message.value = { ok: true, text: 'تم تنزيل نص القرآن من Tanzil وحفظه كما هو دون تعديل.' }
  } catch (e) {
    message.value = { ok: false, text: errText(e) }
  } finally {
    busy.value = false
  }
}
async function installFile(): Promise<void> {
  const path = await pickOpenPath(['txt'], 'Tanzil text')
  if (!path) return
  busy.value = true
  message.value = null
  try {
    status.value = await useApi().request<QuranStatus>(
      'POST',
      '/api/quran/install',
      { kind: kind.value, source_path: path },
      true
    )
    message.value = { ok: true, text: 'تم تثبيت النص من الملف.' }
  } catch (e) {
    message.value = { ok: false, text: errText(e) }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-4 text-sm" data-testid="quran-settings">
    <p class="text-xs text-slate-500">
      نص القرآن الكريم لا يُضمَّن في التطبيق. يُستخدم فقط لاكتشاف الآيات وحمايتها من التشكيل
      والتعديل، ويُحفظ كما هو دون أي تغيير.
    </p>
    <p data-testid="quran-status">
      الحالة:
      <b
        :class="status?.installed ? 'text-mizaj-emerald' : 'text-mizaj-amber'"
        data-testid="quran-state"
      >
        {{ status?.installed ? `مثبّت (${status.verses} آية)` : 'غير مثبّت' }}
      </b>
    </p>
    <ul v-if="status?.installed" class="text-xs text-slate-500" dir="ltr">
      <li v-for="(t, k) in status.texts" :key="k">{{ k }}</li>
    </ul>
    <p class="rounded border p-2 dark:border-slate-600" data-testid="quran-attribution">
      {{
        status?.attribution_ar ??
        'نص القرآن الكريم من مشروع تنزيل Tanzil.net — مرخّص بموجب CC BY 3.0 — https://tanzil.net'
      }}
    </p>

    <section class="space-y-2">
      <h3 class="font-semibold">تنزيل من Tanzil</h3>
      <label class="flex items-center gap-2">
        <input v-model="accepted" type="checkbox" data-testid="quran-accept" />
        أقبل ترخيص Tanzil (CC BY 3.0): النص يُنسخ حرفياً دون تغيير مع ذكر المصدر
      </label>
      <button
        :class="btn"
        :disabled="!online || !accepted || busy"
        data-testid="quran-download"
        @click="download"
      >
        تنزيل من Tanzil
      </button>
      <p v-if="!online" class="text-xs text-mizaj-amber" data-testid="quran-download-off">
        التنزيل معطّل لأن «تنزيل الموارد المجانية العامة» متوقف. فعّله من تبويب «الاتصال والموارد
        المجانية»، أو نزّل الملف بنفسك واستخدم «تثبيت من ملف». عند التنزيل يغادر جهازك طلب واحد إلى
        tanzil.net فقط.
      </p>
    </section>

    <section class="space-y-2 border-t pt-3 dark:border-slate-700">
      <h3 class="font-semibold">تثبيت من ملف</h3>
      <div class="flex flex-wrap items-center gap-2">
        <select
          v-model="kind"
          class="rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          aria-label="نوع النص"
          data-testid="quran-kind"
        >
          <option v-for="[k, l] in KINDS" :key="k" :value="k">{{ l }}</option>
        </select>
        <button :class="btn" :disabled="busy" data-testid="quran-install" @click="installFile">
          تثبيت من ملف…
        </button>
      </div>
      <button
        class="text-mizaj-emerald underline"
        dir="ltr"
        data-testid="quran-tanzil-link"
        @click="openExternal('https://tanzil.net/download/')"
      >
        https://tanzil.net/download/
      </button>
    </section>

    <p
      v-if="message"
      :class="message.ok ? 'text-mizaj-emerald' : 'text-red-500'"
      role="status"
      data-testid="quran-message"
    >
      {{ message.text }}
    </p>
  </div>
</template>
