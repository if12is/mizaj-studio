<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useApi } from '@renderer/api'
import { sanitizePageHtml } from '@renderer/page/sanitizeHtml'

interface RenderResult {
  html: string
  page: { width_pt: number; height_pt: number; bidi: boolean }
  stats: {
    images: number
    truncated: boolean
    diacritics: { applied: number; skipped: number } | null
  }
  source: 'docx' | 'text'
}

const props = defineProps<{
  documentId: number
  diacritized: boolean
  /** bump to re-render (after a diacritization run) */
  tick: number
  zoom: number
  /** flush autosave first so the server renders the latest saved text */
  beforeRender: () => Promise<void>
}>()

const html = ref('')
const loading = ref(false)
const error = ref('')
const note = ref('')
let seq = 0

async function load(): Promise<void> {
  const my = ++seq
  loading.value = true
  error.value = ''
  try {
    await props.beforeRender()
    const r = await useApi().post<RenderResult>('/api/docx/render', {
      document_id: props.documentId,
      diacritized: props.diacritized
    })
    if (my !== seq) return
    html.value = sanitizePageHtml(r.html)
    const d = r.stats.diacritics
    note.value =
      d && d.skipped > 0
        ? `تعذّر تطبيق التشكيل على ${d.skipped} فقرة (تغيّر نصها)؛ تظهر كما في الأصل.`
        : ''
    if (r.stats.truncated) note.value += ' العرض مقتطع لكبر المستند.'
  } catch (e) {
    if (my === seq) error.value = e instanceof Error ? e.message : 'تعذّر عرض الصفحة'
  } finally {
    if (my === seq) loading.value = false
  }
}

onMounted(() => void load())
watch(
  () => [props.documentId, props.diacritized, props.tick],
  () => void load()
)
const scale = computed(() => String(props.zoom / 100))
</script>

<template>
  <div class="page-view" data-testid="page-view" dir="rtl">
    <div v-if="loading && !html" class="pv-msg" role="status">جارٍ تجهيز عرض الصفحة…</div>
    <div v-if="error" class="pv-msg pv-err" role="alert" data-testid="page-view-error">
      {{ error }}
    </div>
    <div v-if="note" class="pv-msg" role="status" data-testid="page-view-note">{{ note }}</div>
    <div class="pv-stage">
      <!-- html is sanitized twice: built escaped/whitelisted by the backend, then re-filtered -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="pv-zoom" :style="{ zoom: scale }" data-testid="page-view-page" v-html="html" />
    </div>
  </div>
</template>

<style>
.page-view {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  overflow: auto;
  background: #6b7280;
  padding: 16px 0 40px;
}
.dark .page-view {
  background: #0f172a;
}
.page-view .pv-msg {
  position: sticky;
  top: 0;
  z-index: 5;
  margin: 0 auto 8px;
  width: fit-content;
  max-width: 90%;
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 12px;
  background: #fef3c7;
  color: #451a03;
}
.page-view .pv-err {
  background: #fee2e2;
  color: #7f1d1d;
}
.page-view .pv-stage {
  display: flex;
  justify-content: center;
  min-width: max-content;
}
.page-view .dp-page {
  position: relative;
  flex: none;
  margin: 0 auto;
  background: #fff;
  color: #000;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.5);
  text-align: start;
}
.page-view .dp-page p {
  margin: 0;
  white-space: pre-wrap;
  tab-size: 36pt;
  overflow-wrap: anywhere;
}
.page-view .dp-page td > p:last-child {
  margin-bottom: 0;
}
.page-view .dp-page table {
  border-spacing: 0;
}
.page-view .dp-page img {
  max-width: none;
}
.page-view .dp-num {
  margin-inline-end: 0.5em;
}
.page-view .dp-pagebreak {
  display: block;
  border-top: 1px dashed #9ca3af;
  margin: 8pt 0;
}
</style>
