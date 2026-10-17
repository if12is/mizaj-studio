<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useCitationsStore } from '@renderer/stores/legalTools'
import { useEditorStore } from '@renderer/stores/editor'

const cit = useCitationsStore()
const editor = useEditorStore()
const fileInput = ref<HTMLInputElement | null>(null)
const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
const btn =
  'rounded border px-2 py-0.5 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700'
onMounted(() => void cit.loadIndex())

async function onFile(ev: Event): Promise<void> {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  await cit.importIndex(await f.text())
  if (fileInput.value) fileInput.value.value = ''
}
</script>

<template>
  <div class="space-y-3 p-3 text-sm" data-testid="citations-tool">
    <p class="text-xs text-slate-500">
      تتحقق الأداة من صياغة الاستشهادات واتساقها فقط، لا من صحة المادة أو سريانها.
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <select
        v-model="cit.style"
        :class="field"
        aria-label="نمط كتابة المادة"
        data-testid="cit-style"
      >
        <option value="paren">المادة (5)</option>
        <option value="plain">المادة 5</option>
      </select>
      <label class="flex items-center gap-1">
        <input v-model="cit.useIndex" type="checkbox" data-testid="cit-use-index" />
        استخدام فهرس القوانين
      </label>
    </div>
    <button
      class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
      :disabled="cit.running || !editor.accessor"
      data-testid="cit-run"
      @click="cit.run()"
    >
      فحص الاستشهادات
    </button>

    <template v-if="cit.result">
      <p class="text-xs" data-testid="cit-counts">
        قوانين: <b>{{ cit.result.laws.length }}</b> — مواد:
        <b>{{ cit.result.articles.length }}</b> — أحكام/طعون: <b>{{ cit.result.cases.length }}</b> —
        آيات: <b>{{ cit.result.quran.length }}</b>
      </p>
      <section v-if="cit.found.length" data-testid="cit-issues">
        <h3 class="font-semibold">ملاحظات ({{ cit.found.length }})</h3>
        <ul class="space-y-1">
          <li
            v-for="(i, n) in cit.found"
            :key="n"
            class="rounded border p-2 dark:border-slate-600"
            data-testid="cit-issue"
          >
            <button class="block w-full text-start" @click="editor.accessor?.jumpTo(i.from, i.to)">
              <span class="font-editor">{{ i.text.slice(0, 60) }}</span>
              <span class="block text-xs text-mizaj-amber">{{ i.message_ar }}</span>
            </button>
          </li>
        </ul>
      </section>
      <section data-testid="cit-suggestions">
        <h3 class="font-semibold">اقتراحات التنسيق ({{ cit.edits.length }})</h3>
        <p v-if="!cit.edits.length" class="text-mizaj-emerald" data-testid="cit-clean">
          لا توجد اقتراحات تنسيق.
        </p>
        <ul class="space-y-1">
          <li
            v-for="(e, n) in cit.edits"
            :key="n"
            class="rounded border p-2 dark:border-slate-600"
            data-testid="cit-suggestion"
          >
            <button
              class="block w-full text-start"
              data-testid="cit-jump"
              @click="editor.accessor?.jumpTo(e.from, e.to)"
            >
              <span class="font-editor">{{ e.expected }}</span>
              ←
              <span class="font-editor font-semibold">{{ e.insert }}</span>
            </button>
            <button
              class="mt-1 rounded bg-mizaj-emerald px-2 py-0.5 text-xs text-white"
              data-testid="cit-apply"
              @click="cit.applyOne(e)"
            >
              تطبيق
            </button>
          </li>
        </ul>
        <button
          v-if="cit.edits.length > 1"
          :class="btn"
          data-testid="cit-apply-all"
          @click="cit.applyAll()"
        >
          تطبيق الكل (خطوة تراجع واحدة)
        </button>
      </section>
      <p class="text-xs text-slate-500">{{ cit.result.disclaimer_ar }}</p>
    </template>

    <section class="space-y-1 border-t pt-3 dark:border-slate-700" data-testid="law-index">
      <h3 class="font-semibold">فهرس القوانين (اختياري)</h3>
      <p class="text-xs text-slate-500">
        ملف JSON يعدّه المستخدم (اسم القانون ورقمه وسنته وعدد مواده) ليفحص التطبيق وجود المادة.
        يُحفظ محلياً فقط.
        <span v-if="cit.indexCount !== null" data-testid="law-index-count">
          الحالي: {{ cit.indexCount }} قانوناً.
        </span>
      </p>
      <div class="flex flex-wrap gap-2">
        <button :class="btn" data-testid="law-index-import" @click="fileInput?.click()">
          استيراد JSON
        </button>
        <button :class="btn" data-testid="law-index-export" @click="cit.exportIndex()">
          تصدير JSON
        </button>
        <button :class="btn" data-testid="law-index-clear" @click="cit.clearIndex()">
          حذف الفهرس
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="hidden"
          data-testid="law-index-file"
          @change="onFile"
        />
      </div>
    </section>
  </div>
</template>
