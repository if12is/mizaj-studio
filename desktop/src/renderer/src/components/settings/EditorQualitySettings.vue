<script setup lang="ts">
/**
 * Editor-quality settings (confidence, review, Quran protection, typography, optional tools,
 * proper nouns). Mountable standalone: no props, no emits; everything lives in the stores.
 * UI-B mounts it inside the Settings dialog.
 */
import { onMounted } from 'vue'
import { useQualityStore } from '@renderer/stores/quality'
import { useSettingsStore } from '@renderer/stores/settings'
import NamesManager from './NamesManager.vue'

const settings = useSettingsStore()
const quality = useQualityStore()
onMounted(() => void quality.loadTools())
const on = (k: string, dflt = true): boolean => (settings.values[k] ?? String(dflt)) !== 'false'
const set = (k: string, v: boolean): Promise<void> => settings.update({ [k]: String(v) })
</script>

<template>
  <section
    class="space-y-4 text-sm"
    data-testid="editor-quality-settings"
    aria-label="إعدادات جودة التحرير"
  >
    <div>
      <h3 class="mb-1 font-semibold">ثقة التشكيل والمراجعة</h3>
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          :checked="on('confidence_show')"
          data-testid="setting-confidence-show"
          @change="set('confidence_show', ($event.target as HTMLInputElement).checked)"
        />
        إظهار الكلمات منخفضة الثقة بعد التشكيل (خط منقّط)
      </label>
      <label class="mt-1 flex items-center gap-2">
        حدّ الثقة
        <input
          type="range"
          min="0.1"
          max="0.99"
          step="0.01"
          :value="quality.confidenceThreshold"
          aria-label="حد الثقة"
          data-testid="setting-confidence-threshold"
          @change="
            settings.update({ confidence_threshold: ($event.target as HTMLInputElement).value })
          "
        />
        <span data-testid="setting-confidence-value">{{
          quality.confidenceThreshold.toFixed(2)
        }}</span>
      </label>
      <p class="text-xs text-slate-500">
        F7 / Shift+F7 للتنقل بين الكلمات المشكوك فيها، Ctrl+Enter لإبقاء التشكيل.
      </p>
    </div>

    <div>
      <h3 class="mb-1 font-semibold">حماية القرآن الكريم</h3>
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          :checked="quality.quranProtect"
          data-testid="setting-quran-protect"
          @change="set('quran_protect', ($event.target as HTMLInputElement).checked)"
        />
        منع تعديل الآيات المكتشفة في المحرر
      </label>
      <p
        v-if="quality.quranInstalled === false"
        class="mt-1 text-xs text-mizaj-amber"
        data-testid="quran-not-installed"
      >
        نص القرآن غير مثبّت، لذلك لا يمكن اكتشاف الآيات.
        <button
          class="underline"
          data-testid="quran-open-install"
          @click="quality.openSettings('quran')"
        >
          تثبيت النص
        </button>
      </p>
    </div>

    <div>
      <h3 class="mb-1 font-semibold">التدقيق الطباعي والنحوي</h3>
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          :checked="on('spell_cat_typography')"
          data-testid="setting-cat-typography"
          @change="set('spell_cat_typography', ($event.target as HTMLInputElement).checked)"
        />
        إظهار ملاحظات التنسيق الطباعي (تطويل، أشكال عرض، مسافات خفية)
      </label>
      <label class="flex items-center gap-2" :class="quality.ltOn ? '' : 'opacity-60'">
        <input
          type="checkbox"
          :checked="on('spell_cat_grammar')"
          :disabled="!quality.ltOn"
          data-testid="setting-cat-grammar"
          @change="set('spell_cat_grammar', ($event.target as HTMLInputElement).checked)"
        />
        ملاحظات نحوية من LanguageTool (محلي)
        <span class="text-xs text-slate-500">
          {{
            quality.ltOn
              ? 'مفعّل ومكتشف'
              : settings.values.online_languagetool === 'true'
                ? 'المفتاح مفعّل لكن الخادم المحلي غير مكتشف؛ شغّل LanguageTool على المنفذ 8081'
                : 'يتطلب تفعيله في «الاتصال والموارد المجانية» وتشغيل الخادم المحلي'
          }}
        </span>
      </label>
      <p
        class="text-xs"
        :class="quality.ollamaOn ? 'text-mizaj-emerald' : 'text-slate-500'"
        data-testid="ollama-status"
      >
        رأي Ollama المحلي في نافذة الكلمة:
        {{
          quality.ollamaOn
            ? 'مفعّل'
            : settings.values.online_ollama === 'true'
              ? 'المفتاح مفعّل لكن Ollama غير مكتشف؛ شغّله على هذا الجهاز'
              : 'غير مفعّل'
        }}
      </p>
    </div>

    <div>
      <h3 class="mb-1 font-semibold">الأعلام (أسماء الأشخاص والأماكن)</h3>
      <NamesManager />
    </div>
  </section>
</template>
