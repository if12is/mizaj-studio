<script setup lang="ts">
import { ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { useFileStore } from '@renderer/stores/fileio'
import { DEFAULT_TRACKED, TRACK_SCOPES, type TrackScope } from '@renderer/files/formats'

/** Options of «تصدير Word مع تعقّب التغييرات»: what is recorded as Word revisions. */
const files = useFileStore()
const scope = ref<TrackScope>(DEFAULT_TRACKED.scope)
const perWord = ref(DEFAULT_TRACKED.granularity === 'word')

const confirm = (): void =>
  files.answerTracked({ scope: scope.value, granularity: perWord.value ? 'word' : 'char' })
</script>

<template>
  <ModalShell
    title="تصدير Word مع تعقّب التغييرات"
    testid="tracked-dialog"
    @close="files.answerTracked(null)"
  >
    <p class="text-sm text-slate-600 dark:text-slate-300">
      كل تغيير يصبح مراجعة حقيقية في Word (باسم «مِزَاج»)، فيقبل زميلك كل تغيير أو يرفضه على حدة.
      «قبول الكل» يعطي النص المعالَج و«رفض الكل» يعيد الأصل.
    </p>
    <fieldset class="mt-3 space-y-1.5" data-testid="tracked-scope">
      <legend class="mb-1 text-sm font-semibold">ما الذي يُتعقَّب؟</legend>
      <label v-for="[v, label] in TRACK_SCOPES" :key="v" class="flex items-center gap-2 text-sm">
        <input
          v-model="scope"
          type="radio"
          name="track-scope"
          :value="v"
          :data-testid="`tracked-scope-${v}`"
        />
        {{ label }}
      </label>
    </fieldset>
    <label class="mt-3 flex items-center gap-2 text-sm">
      <input v-model="perWord" type="checkbox" data-testid="tracked-per-word" />
      التشكيل مراجعةً لكل كلمة (أسهل قراءةً من مراجعة لكل حرف)
    </label>
    <div class="mt-4 flex items-center gap-2">
      <button
        class="rounded bg-mizaj-emerald px-3 py-1 text-sm font-semibold text-white"
        data-testid="tracked-confirm"
        @click="confirm"
      >
        اختيار مكان الحفظ وتصدير
      </button>
      <button
        class="rounded border px-3 py-1 text-sm hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
        data-testid="tracked-cancel"
        @click="files.answerTracked(null)"
      >
        إلغاء
      </button>
    </div>
  </ModalShell>
</template>
