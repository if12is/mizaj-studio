<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue'
import { useOnlineStore } from '@renderer/stores/online'
import { useSettingsStore } from '@renderer/stores/settings'
import { openExternal } from '@renderer/lib/native'
import GeminiSettings from './GeminiSettings.vue'
import {
  LEAVES_AR,
  ONLINE_KEYS,
  ONLINE_LABEL,
  RESOURCE_KIND_LABEL,
  TOOL_INFO,
  formatBytes,
  jobActive,
  jobPercent
} from '@renderer/online/helpers'

const online = useOnlineStore()
const settings = useSettingsStore()
const accepted = reactive<Record<string, boolean>>({})
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'

onMounted(() => {
  void online.loadStatus()
  void online.loadResources()
  void online.refreshTools()
})
onBeforeUnmount(() => online.dispose())

const isOn = (k: (typeof ONLINE_KEYS)[number]): boolean => settings.values[k] === 'true'
const toolKeys = ['languagetool', 'tesseract'] as const
</script>

<template>
  <div class="space-y-5 text-sm" data-testid="online-settings">
    <section
      class="space-y-1 rounded border p-3 dark:border-slate-600"
      data-testid="online-explainer"
    >
      <p>
        مِزَاج يعمل بالكامل دون إنترنت. الخيارات أدناه <b>اختيارية ومعطّلة افتراضياً</b>: تنزيل
        موارد مجانية عامة، أو الاستفادة من أدوات مجانية تثبّتها أنت على جهازك. لا يوجد خادم تابع
        للمشروع ولا حسابات ولا مزامنة، ولا يُرسل نص مستنداتك إلى أي جهة، إلا إذا فعّلتَ بنفسك «مساعد
        Gemini» أدناه (اختياري ومعطّل افتراضياً).
      </p>
    </section>

    <section class="space-y-3" data-testid="online-switches">
      <h3 class="font-semibold">المفاتيح</h3>
      <div v-for="k in ONLINE_KEYS" :key="k" class="rounded border p-2 dark:border-slate-600">
        <label class="flex items-center gap-2 font-semibold">
          <input
            type="checkbox"
            role="switch"
            :checked="isOn(k)"
            :data-testid="`switch-${k.replace(/_/g, '-')}`"
            @change="online.setSwitch(k, ($event.target as HTMLInputElement).checked)"
          />
          {{ ONLINE_LABEL[k].title }}
        </label>
        <p class="text-xs text-slate-500">{{ ONLINE_LABEL[k].help }}</p>
        <p class="mt-1 text-xs" :data-testid="`leaves-${k.replace(/_/g, '-')}`">
          <b>ما يغادر جهازك:</b> {{ LEAVES_AR[k] }}
        </p>
        <p
          v-if="online.status?.leaves_device?.[k]"
          class="text-xs text-slate-500"
          dir="ltr"
          :data-testid="`leaves-en-${k.replace(/_/g, '-')}`"
        >
          {{ online.status.leaves_device[k] }}
        </p>
      </div>
      <p v-if="online.status" class="text-xs text-slate-500" dir="ltr" data-testid="allowed-hosts">
        Allowed hosts: {{ online.status.allowed_hosts.join(', ') }}
      </p>
    </section>

    <GeminiSettings />

    <section class="space-y-1" data-testid="online-log">
      <h3 class="font-semibold">آخر الطلبات الصادرة</h3>
      <p
        v-if="!online.status?.recent_requests.length"
        class="text-slate-500"
        data-testid="online-log-empty"
      >
        لم يُرسل التطبيق أي طلب شبكة.
      </p>
      <ul v-else class="max-h-32 space-y-0.5 overflow-auto text-xs" dir="ltr">
        <li v-for="(r, i) in online.status.recent_requests" :key="i" data-testid="online-log-item">
          [{{ r.kind }}] {{ r.url }} → {{ r.outcome }}
        </li>
      </ul>
    </section>

    <section class="space-y-2 border-t pt-3 dark:border-slate-700" data-testid="resources-section">
      <h3 class="font-semibold">كتالوج الموارد المجانية</h3>
      <p
        v-if="!isOn('online_resources')"
        class="text-xs text-mizaj-amber"
        data-testid="resources-off-note"
      >
        التنزيل التلقائي معطّل. فعّل «تنزيل الموارد المجانية العامة» أعلاه، أو نزّل الملف بنفسك
        واستورده من ملف.
      </p>
      <ul class="space-y-2" data-testid="resources-list">
        <li
          v-for="r in online.resources"
          :key="r.id"
          class="space-y-1 rounded border p-2 dark:border-slate-600"
          data-testid="resource-item"
          :data-id="r.id"
        >
          <div class="flex items-center justify-between">
            <b>{{ r.name }}</b>
            <span
              class="rounded px-2 py-0.5 text-xs text-white"
              :class="r.installed ? 'bg-mizaj-emerald' : 'bg-slate-500'"
              data-testid="resource-state"
            >
              {{ r.installed ? 'مثبّت' : 'غير مثبّت' }}
            </span>
          </div>
          <p class="text-xs text-slate-500">
            {{ RESOURCE_KIND_LABEL[r.kind] ?? r.kind }} — الحجم: {{ formatBytes(r.size) }} —
            الترخيص:
            <button
              class="text-mizaj-emerald underline"
              dir="ltr"
              data-testid="resource-license"
              @click="openExternal(r.license_url)"
            >
              {{ r.license }}
            </button>
          </p>
          <p class="text-xs text-slate-500">{{ r.attribution }}</p>
          <p v-if="r.notes" class="text-xs text-slate-500" dir="ltr">{{ r.notes }}</p>

          <div v-if="jobActive(r.job)" class="space-y-1" data-testid="resource-progress">
            <div
              class="h-2 overflow-hidden rounded bg-slate-200 dark:bg-slate-700"
              role="progressbar"
              :aria-valuenow="jobPercent(r.job) ?? undefined"
              aria-valuemin="0"
              aria-valuemax="100"
              aria-label="تقدم التنزيل"
            >
              <div
                class="h-full bg-mizaj-emerald"
                :style="{ width: (jobPercent(r.job) ?? 5) + '%' }"
              />
            </div>
            <button
              :class="btn"
              data-testid="resource-cancel"
              @click="online.cancel(r.id, r.job!.id)"
            >
              إلغاء التنزيل
            </button>
          </div>
          <p
            v-else-if="r.job && r.job.status === 'failed'"
            class="text-xs text-red-500"
            data-testid="resource-error"
          >
            {{ r.job.error?.message_ar ?? 'فشل التنزيل. أعد المحاولة لاحقاً.' }}
          </p>

          <label class="flex items-center gap-2 text-xs">
            <input v-model="accepted[r.id]" type="checkbox" data-testid="resource-accept" />
            قرأت الترخيص ({{ r.license }}) وأقبل شروطه
          </label>
          <div class="flex flex-wrap gap-2">
            <button
              v-if="!r.requires_user_file"
              :class="btn"
              :disabled="!accepted[r.id] || !isOn('online_resources') || jobActive(r.job)"
              :title="!isOn('online_resources') ? 'فعّل تنزيل الموارد أولاً' : ''"
              data-testid="resource-download"
              @click="online.download(r.id, !!accepted[r.id])"
            >
              تنزيل
            </button>
            <button
              :class="btn"
              :disabled="!accepted[r.id]"
              data-testid="resource-import"
              @click="online.importFile(r.id, !!accepted[r.id])"
            >
              استيراد من ملف
            </button>
          </div>
          <p v-if="r.requires_user_file" class="text-xs text-slate-500">
            لا يوجد اختزال مثبّت لهذا المورد؛ نزّله بنفسك من موقعه ثم استورده من ملف.
          </p>
        </li>
      </ul>
      <p
        v-if="online.message"
        :class="online.message.ok ? 'text-mizaj-emerald' : 'text-red-500'"
        role="status"
        data-testid="resources-message"
      >
        {{ online.message.text }}
      </p>
    </section>

    <section class="space-y-2 border-t pt-3 dark:border-slate-700" data-testid="tools-section">
      <div class="flex items-center justify-between">
        <h3 class="font-semibold">الأدوات المحلية المجانية</h3>
        <button
          :class="btn"
          :disabled="online.toolsLoading"
          data-testid="tools-refresh"
          @click="online.refreshTools()"
        >
          إعادة الكشف
        </button>
      </div>
      <ul class="space-y-2">
        <li
          v-for="t in toolKeys"
          :key="t"
          class="space-y-1 rounded border p-2 dark:border-slate-600"
          :data-testid="`tool-${t}`"
        >
          <div class="flex items-center justify-between">
            <b>{{ TOOL_INFO[t].title }}</b>
            <span
              class="rounded px-2 py-0.5 text-xs text-white"
              :class="online.tools?.[t].detected ? 'bg-mizaj-emerald' : 'bg-slate-500'"
              :data-testid="`tool-${t}-state`"
            >
              {{ online.tools?.[t].detected ? 'جاهز' : online.tools ? 'غير مثبّت' : '…' }}
            </span>
          </div>
          <template v-if="online.tools && !online.tools[t].detected">
            <p class="text-xs text-slate-500">{{ TOOL_INFO[t].install }}</p>
            <p
              v-if="t === 'tesseract' && online.tools.tesseract.hint"
              class="text-xs text-slate-500"
              dir="ltr"
              data-testid="tesseract-hint"
            >
              {{ online.tools.tesseract.hint }}
            </p>
            <button
              :class="btn"
              :data-testid="`tool-${t}-link`"
              @click="openExternal(TOOL_INFO[t].url)"
            >
              صفحة التنزيل (يُفتح في المتصفح)
            </button>
          </template>
        </li>
      </ul>
    </section>
  </div>
</template>
