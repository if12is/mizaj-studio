<script setup lang="ts">
import { ref } from 'vue'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { useEditorStore } from '@renderer/stores/editor'

const editor = useEditorStore()
const el = ref<HTMLElement | null>(null)
useFocusTrap(el, () => (editor.shortcutsOpen = false))
const rows = [
  ['Ctrl+Shift+T', 'تشكيل المحدد أو كامل المقال'],
  ['Ctrl+Alt+T', 'تشكيل الفقرة الحالية مع معاينة قبل القبول'],
  ['Ctrl+Shift+R', 'إزالة التشكيل من المحدد'],
  ['Ctrl+Shift+C', 'نسخ النص بدون حركات'],
  ['Ctrl+Space / Ctrl+.', 'فتح نافذة تشكيل الكلمة'],
  ['Ctrl+F', 'بحث واستبدال واعٍ بالتشكيل'],
  ['F3 / Shift+F3', 'نتيجة البحث التالية / السابقة'],
  ['Ctrl+Shift+L', 'تدقيق إملائي كامل'],
  ['F8 / Shift+F8', 'الملاحظة الإملائية التالية / السابقة'],
  ['Ctrl+= / Ctrl+- / Ctrl+0', 'تكبير / تصغير / إعادة حجم الخط'],
  ['Ctrl+Z / Ctrl+Y', 'تراجع / إعادة'],
  ['Esc', 'إغلاق النافذة أو رفض المعاينة'],
  ['Ctrl+K / Ctrl+Shift+P', 'البحث الشامل ولوحة الأوامر'],
  ['Ctrl+T / Ctrl+W', 'تبويب جديد / إغلاق التبويب'],
  ['Ctrl+Tab / Ctrl+Shift+Tab', 'التبويب التالي / السابق'],
  ['Ctrl+/', 'هذه القائمة']
]
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="editor.shortcutsOpen = false"
  >
    <div
      ref="el"
      class="w-[34rem] max-w-[95vw] rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      data-testid="shortcuts-dialog"
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 id="shortcuts-title" class="text-lg font-bold">اختصارات لوحة المفاتيح</h2>
        <button
          aria-label="إغلاق"
          data-testid="shortcuts-close"
          @click="editor.shortcutsOpen = false"
        >
          ✕
        </button>
      </div>
      <table class="w-full text-sm">
        <tbody>
          <tr v-for="[k, d] in rows" :key="k" class="border-b dark:border-slate-700">
            <td class="py-1 font-mono" dir="ltr">{{ k }}</td>
            <td class="py-1">{{ d }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
