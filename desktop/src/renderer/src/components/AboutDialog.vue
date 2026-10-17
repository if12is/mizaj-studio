<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { useEditorStore } from '@renderer/stores/editor'

const editor = useEditorStore()
const el = ref<HTMLElement | null>(null)
useFocusTrap(el, () => (editor.aboutOpen = false))
const info = ref<{
  version: string
  electron: string
  license: string
  portable: boolean
  licenses: string | null
} | null>(null)
onMounted(async () => {
  info.value = (await window.mizajAPI?.getAboutInfo()) ?? null
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="editor.aboutOpen = false"
  >
    <div
      ref="el"
      class="w-[40rem] max-w-[95vw] rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      data-testid="about-dialog"
    >
      <div class="mb-2 flex items-center justify-between">
        <h2 id="about-title" class="text-lg font-bold">حول مِزَاج</h2>
        <button aria-label="إغلاق" data-testid="about-close" @click="editor.aboutOpen = false">
          ✕
        </button>
      </div>
      <p data-testid="about-version">
        الإصدار {{ info?.version ?? '—' }}<span v-if="info?.portable"> (نسخة محمولة)</span>
      </p>
      <p data-testid="about-license">
        الترخيص: GNU General Public License v3.0 أو أحدث (GPL-3.0-or-later)
      </p>
      <p class="text-xs text-slate-500" dir="ltr">
        Source: github.com/if12is/mizaj-studio/tree/v{{ info?.version ?? '' }}
      </p>
      <h3 class="mt-3 font-semibold">تراخيص المكونات الخارجية</h3>
      <pre
        class="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border p-2 text-xs dark:border-slate-600"
        dir="ltr"
        tabindex="0"
        aria-label="تراخيص المكونات الخارجية"
        data-testid="about-licenses"
        >{{ info?.licenses ?? 'ملف التراخيص غير متوفر في هذا البناء.' }}</pre
      >
    </div>
  </div>
</template>
