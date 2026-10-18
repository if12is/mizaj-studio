<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useGeminiStore } from '@renderer/stores/gemini'
import { openExternal } from '@renderer/lib/native'

const gemini = useGeminiStore()
const keyInput = ref('')
const reveal = ref(false)
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'

onMounted(async () => {
  await gemini.load()
  if (gemini.state?.hasKey) void gemini.loadModels()
})

async function save(): Promise<void> {
  const k = keyInput.value.trim()
  if (!k) return
  if (await gemini.saveKey(k)) keyInput.value = ''
}
async function test(): Promise<void> {
  await gemini.testKey(keyInput.value.trim() || undefined)
}
</script>

<template>
  <section class="space-y-3 rounded border p-3 dark:border-slate-600" data-testid="gemini-settings">
    <h3 class="font-semibold">مساعد Gemini (اختياري)</h3>
    <p class="text-xs text-slate-500">
      مساعد يجيب عن أسئلتك حول المستند أو عن كلمة بعينها ويقترح أو يؤكد شكّاً فقط؛ لا يعدّل نصك
      أبداً. <b>ما يغادر جهازك:</b> النص المحدد أو مقتطف المستند وسؤالك، عند طرح سؤال فقط، وإلى
      Google فقط.
    </p>
    <label class="flex items-center gap-2 font-semibold">
      <input
        type="checkbox"
        role="switch"
        data-testid="gemini-enable"
        :checked="gemini.enabled"
        @change="gemini.setConfig({ enabled: ($event.target as HTMLInputElement).checked })"
      />
      تفعيل مساعد Gemini
    </label>

    <template v-if="gemini.enabled">
      <label class="flex items-center gap-2">
        المزوّد:
        <select
          class="rounded border px-2 py-0.5 dark:border-slate-600 dark:bg-slate-800"
          data-testid="gemini-provider"
          :value="gemini.provider"
          @change="
            gemini.setConfig({
              provider: ($event.target as HTMLSelectElement).value as 'api' | 'cli'
            })
          "
        >
          <option value="api">مفتاح API</option>
          <option value="cli">Gemini CLI</option>
        </select>
      </label>

      <div class="space-y-2 rounded border p-2 dark:border-slate-700" data-testid="gemini-api-box">
        <h4 class="font-semibold">مفتاح API من Google AI Studio</h4>
        <p
          v-if="gemini.state && !gemini.state.encryptionAvailable"
          class="text-xs text-mizaj-amber"
        >
          التشفير الآمن غير متاح على هذا الجهاز، لذلك لا يمكن حفظ المفتاح (لن يُحفظ نصاً صريحاً).
        </p>
        <p v-if="gemini.state?.hasKey" class="text-xs" data-testid="gemini-key-hint" dir="ltr">
          مفتاح محفوظ ومشفّر: {{ gemini.state.keyHint }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model="keyInput"
            :type="reveal ? 'text' : 'password'"
            class="w-72 rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
            dir="ltr"
            autocomplete="off"
            spellcheck="false"
            placeholder="AIza…"
            aria-label="مفتاح API"
            data-testid="gemini-key-input"
          />
          <button
            :class="btn"
            type="button"
            data-testid="gemini-key-reveal"
            @click="reveal = !reveal"
          >
            {{ reveal ? 'إخفاء' : 'إظهار' }}
          </button>
          <button
            :class="btn"
            data-testid="gemini-key-save"
            :disabled="!keyInput.trim()"
            @click="save"
          >
            حفظ المفتاح
          </button>
          <button :class="btn" data-testid="gemini-key-test" :disabled="gemini.busy" @click="test">
            اختبار المفتاح
          </button>
          <button
            v-if="gemini.state?.hasKey"
            :class="btn"
            data-testid="gemini-key-clear"
            @click="gemini.clearKey()"
          >
            حذف المفتاح
          </button>
        </div>
        <p class="text-xs text-slate-500">
          يُحفظ المفتاح مشفّراً بمخزن النظام ولا يظهر في الواجهة ولا في السجلات.
          <button class="underline" @click="openExternal('https://aistudio.google.com/apikey')">
            احصل على مفتاح
          </button>
        </p>
        <label class="flex items-center gap-2">
          النموذج:
          <select
            class="rounded border px-2 py-0.5 dark:border-slate-600 dark:bg-slate-800"
            dir="ltr"
            data-testid="gemini-model-select"
            :value="gemini.config?.model"
            :disabled="!gemini.models.length"
            aria-label="نموذج Gemini"
            @change="gemini.setConfig({ model: ($event.target as HTMLSelectElement).value })"
          >
            <option v-if="!gemini.models.length" value="">— اختبر المفتاح لعرض النماذج —</option>
            <option v-for="m in gemini.models" :key="m.id" :value="m.id">{{ m.id }}</option>
          </select>
          <button
            :class="btn"
            :disabled="!gemini.state?.hasKey"
            data-testid="gemini-models-refresh"
            @click="gemini.loadModels()"
          >
            تحديث القائمة
          </button>
        </label>
        <p v-if="gemini.modelsSource === 'fallback'" class="text-xs text-mizaj-amber">
          تعذر الاتصال بـ Google؛ تُعرض قائمة احتياطية.
        </p>
      </div>

      <div class="space-y-2 rounded border p-2 dark:border-slate-700" data-testid="gemini-cli-box">
        <label class="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="gemini-cli-enable"
            :checked="gemini.config?.useCli"
            @change="gemini.setConfig({ useCli: ($event.target as HTMLInputElement).checked })"
          />
          استخدام Gemini CLI المثبت على الجهاز (يستخدم حسابك المسجل فيه وحدوده)
        </label>
        <p class="flex flex-wrap items-center gap-2 text-xs">
          <span
            class="rounded px-2 py-0.5 text-white"
            :class="gemini.state?.cli.detected ? 'bg-mizaj-emerald' : 'bg-slate-500'"
            data-testid="gemini-cli-status"
          >
            {{ gemini.state?.cli.detected ? 'مكتشف' : 'غير مكتشف' }}
          </span>
          <span v-if="gemini.state?.cli.version" dir="ltr" data-testid="gemini-cli-version">
            {{ gemini.state.cli.version }}
          </span>
          <button :class="btn" data-testid="gemini-cli-redetect" @click="gemini.redetectCli()">
            إعادة الكشف
          </button>
        </p>
        <p
          v-if="gemini.provider === 'cli' && !(gemini.config?.useCli && gemini.state?.cli.detected)"
          class="text-xs text-mizaj-amber"
        >
          اختر «استخدام Gemini CLI» أعلاه وتأكد من اكتشافه ليعمل هذا المزوّد.
        </p>
      </div>
    </template>

    <p
      v-if="gemini.message"
      role="status"
      class="text-sm"
      :class="gemini.message.ok ? 'text-mizaj-emerald' : 'text-mizaj-amber'"
      data-testid="gemini-message"
    >
      {{ gemini.message.text }}
    </p>
  </section>
</template>
