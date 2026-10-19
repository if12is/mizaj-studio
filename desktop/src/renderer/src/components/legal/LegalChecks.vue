<script setup lang="ts">
import { computed } from 'vue'
import { GROUP_LABELS, groupIssues } from '@renderer/legal/issues'
import { useLegalStore } from '@renderer/stores/legal'

const legal = useLegalStore()
const groups = computed(() => groupIssues(legal.issues))
</script>

<template>
  <div class="p-3 text-sm" data-testid="legal-checks">
    <button
      class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
      :disabled="legal.running"
      data-testid="legal-check-run"
      @click="legal.runChecks()"
    >
      فحص المستند القانوني
    </button>
    <p
      v-if="legal.checked && !legal.issues.length"
      class="mt-2 text-mizaj-emerald"
      data-testid="legal-check-clean"
    >
      لم يُعثر على ملاحظات.
    </p>
    <section v-for="g in groups" :key="g.group" class="mt-3" :data-group="g.group">
      <h3 class="font-semibold">{{ GROUP_LABELS[g.group] }} ({{ g.items.length }})</h3>
      <ul class="mt-1 space-y-1">
        <li
          v-for="i in g.items"
          :key="i.id"
          class="rounded border p-2 dark:border-slate-600"
          data-testid="legal-issue"
          :data-group="i.group"
          :data-type="i.type"
        >
          <button class="block w-full text-start" data-testid="legal-jump" @click="legal.jump(i)">
            <span class="font-editor">{{ i.expected.slice(0, 60) }}</span>
            <span class="block text-xs text-slate-500">{{ i.message_ar }}</span>
            <span class="text-xs text-mizaj-emerald">انتقال ↖</span>
          </button>
          <p v-if="i.note" class="text-xs text-mizaj-amber">{{ i.note }}</p>
          <button
            v-if="i.fix"
            class="mt-1 rounded bg-mizaj-emerald px-2 py-0.5 text-xs text-white"
            data-testid="legal-apply"
            @click="legal.applyFix(i)"
          >
            تطبيق: {{ i.fix.label }}
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>
