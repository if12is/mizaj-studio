<script setup lang="ts">
import { ref } from 'vue'
import { usePacksStore } from '@renderer/stores/packs'

const packs = usePacksStore()
const includeModels = ref(false)
const confirmRestore = ref(false)
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'
</script>

<template>
  <div class="space-y-5 text-sm" data-testid="backup-settings">
    <section class="space-y-2">
      <h3 class="font-semibold">نسخة احتياطية كاملة</h3>
      <p class="text-xs text-slate-500">
        ملف واحد (‎.mizajbackup‎) يضم مشاريعك ومستنداتك وقاموسك وإعداداتك والموارد المنزَّلة. يُحفظ
        على جهازك فقط.
      </p>
      <label class="flex items-center gap-2">
        <input v-model="includeModels" type="checkbox" data-testid="backup-include-models" />
        تضمين النماذج (يزيد الحجم كثيراً)
      </label>
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 text-white disabled:opacity-50"
        :disabled="packs.busy"
        data-testid="backup-export"
        @click="packs.exportBackup(includeModels)"
      >
        إنشاء نسخة احتياطية…
      </button>
    </section>

    <section class="space-y-2 border-t pt-3 dark:border-slate-700">
      <h3 class="font-semibold">استعادة نسخة</h3>
      <button
        :class="btn"
        :disabled="packs.busy"
        data-testid="backup-choose"
        @click="packs.chooseBackup()"
      >
        اختيار ملف نسخة احتياطية…
      </button>
      <div
        v-if="packs.backup"
        class="space-y-2 rounded border p-3 dark:border-slate-600"
        data-testid="backup-info"
      >
        <p>
          تاريخ الإنشاء: <b data-testid="backup-created">{{ packs.backup.info.created_at }}</b> —
          إصدار التطبيق: {{ packs.backup.info.app_version }}
        </p>
        <p>
          عدد الملفات: <b data-testid="backup-files">{{ packs.backup.info.files }}</b> — النماذج:
          {{ packs.backup.info.includes_models ? 'مضمّنة' : 'غير مضمّنة' }}
        </p>
        <p
          v-if="!packs.backup.info.restorable"
          class="text-red-500"
          role="alert"
          data-testid="backup-not-restorable"
        >
          هذه النسخة أحدث من تطبيقك الحالي ولا يمكن استعادتها؛ حدّث التطبيق أولاً.
        </p>
        <template v-else>
          <p class="text-mizaj-amber">
            تحذير: الاستعادة تستبدل بياناتك الحالية (المشاريع والمستندات والقاموس والإعدادات) بمحتوى
            النسخة.
          </p>
          <label class="flex items-center gap-2">
            <input v-model="confirmRestore" type="checkbox" data-testid="backup-confirm" />
            أفهم أن بياناتي الحالية ستُستبدل
          </label>
          <button
            class="rounded bg-red-600 px-3 py-1 text-white disabled:opacity-50"
            :disabled="!confirmRestore || packs.busy || packs.restoreState !== 'idle'"
            data-testid="backup-restore"
            @click="packs.restore()"
          >
            استعادة
          </button>
        </template>
      </div>
      <div v-if="packs.restoreState !== 'idle'" class="space-y-2" data-testid="backup-restart">
        <p
          class="text-mizaj-emerald"
          data-testid="backup-restore-status"
          :data-state="packs.restoreState"
        >
          {{
            packs.restoreState === 'pending'
              ? 'سيتم الاستعادة عند إعادة التشغيل.'
              : 'تمت الاستعادة؛ أعد التشغيل لتحميل البيانات المستعادة.'
          }}
        </p>
        <button
          class="rounded bg-mizaj-emerald px-3 py-1 text-white"
          data-testid="backup-relaunch"
          @click="packs.relaunch()"
        >
          إعادة التشغيل الآن
        </button>
      </div>
    </section>

    <p
      v-if="packs.backupMessage"
      :class="packs.backupMessage.ok ? 'text-mizaj-emerald' : 'text-red-500'"
      role="status"
      data-testid="backup-message"
    >
      {{ packs.backupMessage.text }}
    </p>
  </div>
</template>
