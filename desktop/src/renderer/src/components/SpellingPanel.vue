<script setup lang="ts">
import { useEditorStore } from '@renderer/stores/editor'
import { useSpellingStore } from '@renderer/stores/spelling'

const editor = useEditorStore()
const spelling = useSpellingStore()
const dot: Record<string, string> = {
  error: 'bg-red-500',
  warning: 'bg-mizaj-amber',
  info: 'bg-blue-500'
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col text-sm" data-testid="spell-panel">
    <div class="flex items-center gap-2 border-b px-3 py-2 dark:border-slate-700">
      <span data-testid="spell-count">{{ spelling.marks.length }} ملاحظة</span>
      <button
        class="rounded border px-2 dark:border-slate-600"
        title="Shift+F8"
        data-testid="spell-prev"
        @click="editor.accessor?.spellNav(-1)"
      >
        السابق
      </button>
      <button
        class="rounded border px-2 dark:border-slate-600"
        title="F8"
        data-testid="spell-next"
        @click="editor.accessor?.spellNav(1)"
      >
        التالي
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-auto">
      <p v-if="!spelling.groups.length" class="p-3 text-slate-500" data-testid="spell-empty">
        لا توجد ملاحظات إملائية.
      </p>
      <section
        v-for="g in spelling.groups"
        :key="g.category"
        class="border-b dark:border-slate-700"
      >
        <h3 class="bg-slate-100 px-3 py-1 font-semibold dark:bg-slate-800">
          {{ g.label }} ({{ g.items.length }})
        </h3>
        <ul>
          <li v-for="m in g.items.slice(0, 200)" :key="m.from + ':' + m.to">
            <button
              class="flex w-full items-center gap-2 px-3 py-1 text-start hover:bg-slate-100 dark:hover:bg-slate-800"
              data-testid="spell-issue"
              :data-category="g.category"
              :data-severity="m.severity"
              @click="editor.accessor?.jumpTo(m.from, m.to)"
            >
              <span class="inline-block h-2 w-2 shrink-0 rounded-full" :class="dot[m.severity]" />
              <span class="font-editor truncate">{{ m.word.trim() || '␣' }}</span>
              <span class="truncate text-xs text-slate-500">{{ m.message_ar }}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
