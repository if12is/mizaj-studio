<script setup lang="ts">
import { ref } from 'vue'
import { useSettingsStore } from '@renderer/stores/settings'
import DictionaryPanel from './DictionaryPanel.vue'

const emit = defineEmits<{ (e: 'close'): void }>()
const settings = useSettingsStore()
const tab = ref<'general' | 'dictionary'>('general')
const fontSize = ref(settings.fontSize)

const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="emit('close')"
  >
    <div
      class="w-[40rem] max-w-[95vw] rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
      role="dialog"
      aria-label="الإعدادات"
      data-testid="settings-modal"
    >
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-bold">الإعدادات</h2>
        <button data-testid="settings-close" aria-label="إغلاق" @click="emit('close')">
          &#10005;
        </button>
      </div>
      <div class="mb-3 flex gap-2 border-b dark:border-slate-700">
        <button
          class="px-3 py-1"
          :class="tab === 'general' ? 'border-b-2 border-mizaj-emerald font-semibold' : ''"
          data-testid="tab-general"
          @click="tab = 'general'"
        >
          عام
        </button>
        <button
          class="px-3 py-1"
          :class="tab === 'dictionary' ? 'border-b-2 border-mizaj-emerald font-semibold' : ''"
          data-testid="tab-dictionary"
          @click="tab = 'dictionary'"
        >
          القاموس الشخصي
        </button>
      </div>

      <div v-if="tab === 'general'" class="grid grid-cols-2 items-center gap-3 text-sm">
        <label for="s-engine">وضع المحرك</label>
        <select
          id="s-engine"
          :class="field"
          :value="settings.values.engine_mode"
          data-testid="setting-engine-mode"
          @change="settings.update({ engine_mode: ($event.target as HTMLSelectElement).value })"
        >
          <option value="fast">سريع</option>
          <option value="accurate">دقيق</option>
        </select>

        <label for="s-level">مستوى التشكيل</label>
        <select
          id="s-level"
          :class="field"
          :value="settings.values.tashkeel_level"
          data-testid="setting-tashkeel-level"
          @change="settings.update({ tashkeel_level: ($event.target as HTMLSelectElement).value })"
        >
          <option value="full">كامل</option>
          <option value="irab_only">أواخر الكلمات (الإعراب)</option>
          <option value="minimal">الحد الأدنى (فك اللبس)</option>
        </select>

        <label for="s-font">خط المحرر</label>
        <select
          id="s-font"
          :class="field"
          :value="settings.values.editor_font"
          data-testid="setting-editor-font"
          @change="settings.update({ editor_font: ($event.target as HTMLSelectElement).value })"
        >
          <option value="Amiri">أميري</option>
          <option value="Cairo">القاهرة</option>
        </select>

        <label for="s-size">حجم الخط ({{ fontSize }})</label>
        <input
          id="s-size"
          v-model.number="fontSize"
          type="range"
          min="12"
          max="48"
          data-testid="setting-font-size"
          @change="settings.update({ editor_font_size: String(fontSize) })"
        />

        <label for="s-colored">تلوين الحركات</label>
        <input
          id="s-colored"
          type="checkbox"
          :checked="settings.colored"
          data-testid="setting-colored"
          @change="
            settings.update({
              colored_diacritics: String(($event.target as HTMLInputElement).checked)
            })
          "
        />

        <label for="s-theme">السمة</label>
        <select
          id="s-theme"
          :class="field"
          :value="settings.values.theme"
          data-testid="setting-theme"
          @change="settings.update({ theme: ($event.target as HTMLSelectElement).value })"
        >
          <option value="dark">ليلي</option>
          <option value="light">نهاري</option>
        </select>
      </div>
      <DictionaryPanel v-else />
    </div>
  </div>
</template>
