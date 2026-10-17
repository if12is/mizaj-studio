<script setup lang="ts">
import { useReducedMotion } from '@renderer/lib/motion'
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { lazyPanel } from '@renderer/lib/lazy'
import { useSettingsStore } from '@renderer/stores/settings'
import type { SettingsSection } from '@renderer/stores/settings'
import { useFocusTrap } from '@renderer/composables/useFocusTrap'
import { notify } from '@renderer/api/toast'
import { useEditorStore } from '@renderer/stores/editor'
import { useApi } from '@renderer/api'
import { useUpdaterStore } from '@renderer/stores/updater'
import { useSidecarStore } from '@renderer/stores/sidecar'
import { ApiError } from '@renderer/api/client'

const reduced = useReducedMotion()
const emit = defineEmits<{ (e: 'close'): void }>()
const dialog = ref<HTMLElement | null>(null)
useFocusTrap(dialog, () => emit('close'))
const settings = useSettingsStore()
const sidecar = useSidecarStore()
const tab = ref<SettingsSection>(settings.settingsSection)

// each settings tab is its own chunk, loaded the first time it is opened
const DictionaryPanel = lazyPanel(() => import('./DictionaryPanel.vue'))
const GlossaryPanel = lazyPanel(() => import('./legal/GlossaryPanel.vue'))
const QuranSettings = lazyPanel(() => import('./settings/QuranSettings.vue'))
const OnlineSettings = lazyPanel(() => import('./settings/OnlineSettings.vue'))
const PacksSettings = lazyPanel(() => import('./settings/PacksSettings.vue'))
const BackupSettings = lazyPanel(() => import('./settings/BackupSettings.vue'))

// EditorQualitySettings.vue is owned by another slice; glob keeps the build working while it is absent.
const optional = import.meta.glob('./settings/EditorQualitySettings.vue')
const EditorQuality = optional['./settings/EditorQualitySettings.vue']
  ? defineAsyncComponent(optional['./settings/EditorQualitySettings.vue'] as never)
  : null
const tabs = computed<[SettingsSection, string][]>(() => {
  const list: [SettingsSection, string][] = [
    ['general', 'عام'],
    ['dictionary', 'القاموس الشخصي'],
    ['glossary', 'المعجم القانوني'],
    ['quran', 'القرآن الكريم'],
    ['online', 'الاتصال والموارد المجانية'],
    ['packs', 'الحزم والمشاركة'],
    ['backup', 'النسخ الاحتياطي']
  ]
  if (EditorQuality) list.push(['editor-quality', 'جودة التحرير'])
  return list
})
const fontSize = ref(settings.fontSize)

interface PackStatus {
  installed?: boolean
  version: string | null
  models_dir: string | null
  models_source?: string | null
}
const updater = useUpdaterStore()
const updateText = computed(() => {
  const s = updater.status
  if (s.code === 'not-packaged') return 'التحديثات متاحة فقط في النسخة المثبتة'
  if (s.code === 'portable')
    return 'التحديث التلقائي غير متاح في النسخة المحمولة؛ نزّل الإصدار الجديد يدوياً.'
  switch (s.state) {
    case 'checking':
      return 'جاري التحقق من التحديثات...'
    case 'available':
      return `يتوفر إصدار جديد ${s.version}`
    case 'not-available':
      return 'أنت تستخدم أحدث إصدار.'
    case 'downloading':
      return `جاري التنزيل ${s.percent ?? 0}%`
    case 'downloaded':
      return `تم تنزيل الإصدار ${s.version}، أعد التشغيل للتثبيت.`
    case 'error':
      return `تعذر التحقق من التحديثات: ${s.message ?? ''}`
    default:
      return ''
  }
})
const pack = ref<PackStatus | null>(null)
const packMsg = ref<{ ok: boolean; text: string } | null>(null)
const packBusy = ref(false)
const sourceLabel: Record<string, string> = {
  env: 'مدمجة مع التطبيق',
  'data-dir': 'حزمة محدّثة (.mizajpack)',
  exe: 'مدمجة مع التطبيق',
  dev: 'نسخة التطوير',
  pack: 'حزمة محدّثة (.mizajpack)',
  bundled: 'مدمجة مع التطبيق'
}

async function loadPack(): Promise<void> {
  try {
    pack.value = await useApi().get<PackStatus>('/api/packs/status', true)
  } catch {
    pack.value = null
  }
}
onMounted(() => void loadPack())

async function applyPack(): Promise<void> {
  const api = window.mizajAPI
  const path = api?.showOpenPackDialog
    ? await api.showOpenPackDialog()
    : window.prompt('مسار ملف ‎.mizajpack‎ (مطلق)', '') || null
  if (!path) return
  packBusy.value = true
  packMsg.value = null
  try {
    const r = await useApi().request<{ version?: string; files?: number }>(
      'POST',
      '/api/packs/apply',
      { path },
      true
    )
    packMsg.value = {
      ok: true,
      text: `تم تحديث النماذج بنجاح${r.version ? ` (الإصدار ${r.version})` : ''}.`
    }
    await loadPack()
  } catch (e) {
    const text =
      e instanceof ApiError
        ? e.errorCode === 'ERR_PACK_INVALID'
          ? `ملف الحزمة غير صالح: ${e.messageAr}`
          : e.messageAr
        : 'تعذر تطبيق الحزمة.'
    packMsg.value = { ok: false, text }
  } finally {
    packBusy.value = false
  }
}

const editorStore = useEditorStore()
async function exportDiag(): Promise<void> {
  try {
    const path = await window.mizajAPI?.exportDiagnostics()
    if (path) notify(`تم إنشاء حزمة التشخيص: ${path}`, { kind: 'success', ms: 8000 })
  } catch {
    notify('تعذر إنشاء حزمة التشخيص.')
  }
}

const field = 'rounded border px-2 py-1 dark:border-slate-600 dark:bg-slate-800'
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    @click.self="emit('close')"
  >
    <div
      class="max-h-[90vh] w-[48rem] max-w-[95vw] overflow-y-auto rounded-lg bg-white p-4 shadow-xl dark:bg-slate-800"
      ref="dialog"
      role="dialog"
      aria-modal="true"
      aria-label="الإعدادات"
      data-testid="settings-modal"
    >
      <div
        class="sticky top-0 z-10 mb-3 flex items-center justify-between bg-white dark:bg-slate-800"
      >
        <h2 class="text-lg font-bold">الإعدادات</h2>
        <button data-testid="settings-close" aria-label="إغلاق" @click="emit('close')">
          &#10005;
        </button>
      </div>
      <div class="mb-3 flex flex-wrap gap-x-2 border-b dark:border-slate-700" role="tablist">
        <button
          v-for="[k, label] in tabs"
          :key="k"
          class="px-3 py-1"
          role="tab"
          :aria-selected="tab === k"
          :class="tab === k ? 'border-b-2 border-mizaj-emerald font-semibold' : ''"
          :data-testid="`tab-${k}`"
          @click="tab = k"
        >
          {{ label }}
        </button>
      </div>

      <Transition name="m-tab" :mode="reduced ? undefined : 'out-in'" :css="!reduced">
        <div :key="tab">
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
              <option
                value="accurate"
                :disabled="sidecar.accurateMissing"
                :title="
                  sidecar.accurateMissing
                    ? 'النموذج الدقيق غير متوفر. ثبّت حزمة النماذج من الإعدادات.'
                    : ''
                "
              >
                دقيق
              </option>
            </select>

            <label for="s-level">مستوى التشكيل</label>
            <select
              id="s-level"
              :class="field"
              :value="settings.values.tashkeel_level"
              data-testid="setting-tashkeel-level"
              @change="
                settings.update({ tashkeel_level: ($event.target as HTMLSelectElement).value })
              "
            >
              <option value="full">كامل</option>
              <option value="irab_only">أواخر الكلمات (الإعراب)</option>
              <option value="minimal">الحد الأدنى (فك اللبس)</option>
              <option value="legal">قانوني (حيث يزيل اللبس)</option>
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

            <label for="s-hc">التباين العالي</label>
            <select
              id="s-hc"
              :class="field"
              :value="settings.values.high_contrast"
              data-testid="setting-high-contrast"
              @change="
                settings.update({ high_contrast: ($event.target as HTMLSelectElement).value })
              "
            >
              <option value="auto">حسب النظام</option>
              <option value="true">مفعّل</option>
              <option value="false">معطّل</option>
            </select>
          </div>
          <div
            v-if="tab === 'general'"
            class="mt-4 border-t pt-3 text-sm dark:border-slate-700"
            data-testid="spell-settings"
          >
            <h3 class="mb-2 font-semibold">التدقيق الإملائي</h3>
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                :checked="settings.values.spell_check_enabled !== 'false'"
                data-testid="setting-spell-enabled"
                @change="
                  settings.update({
                    spell_check_enabled: String(($event.target as HTMLInputElement).checked)
                  })
                "
              />
              تفعيل التدقيق الإملائي أثناء الكتابة
            </label>
            <div class="mt-1 flex flex-wrap gap-4">
              <label
                v-for="[key, label] in [
                  ['spell_cat_spelling', 'إملائي (قاموس)'],
                  ['spell_cat_pattern', 'أخطاء شائعة'],
                  ['spell_cat_punctuation', 'ترقيم']
                ]"
                :key="key"
                class="flex items-center gap-1"
              >
                <input
                  type="checkbox"
                  :checked="settings.values[key] !== 'false'"
                  :data-testid="`setting-${key.replace(/_/g, '-')}`"
                  @change="
                    settings.update({ [key]: String(($event.target as HTMLInputElement).checked) })
                  "
                />
                {{ label }}
              </label>
            </div>
          </div>
          <div v-if="tab === 'general'" class="mt-4 border-t pt-3 text-sm dark:border-slate-700">
            <h3 class="mb-2 font-semibold">النماذج</h3>
            <p data-testid="pack-status">
              الإصدار المثبّت:
              <b data-testid="pack-version">{{ pack?.version ?? 'غير محدد' }}</b>
              <span v-if="pack?.models_source" class="text-slate-500">
                — {{ sourceLabel[pack.models_source] ?? pack.models_source }}
              </span>
            </p>
            <button
              class="mt-2 rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700"
              :disabled="packBusy"
              data-testid="pack-apply"
              @click="applyPack"
            >
              تحديث النماذج من ملف (.mizajpack)
            </button>
            <p
              v-if="packMsg"
              class="mt-2"
              :class="packMsg.ok ? 'text-mizaj-emerald' : 'text-red-500'"
              data-testid="pack-result"
            >
              {{ packMsg.text }}
            </p>
          </div>
          <div
            v-if="tab === 'general'"
            class="mt-4 border-t pt-3 text-sm dark:border-slate-700"
            data-testid="help-section"
          >
            <h3 class="mb-2 font-semibold">المساعدة</h3>
            <div class="flex flex-wrap gap-2">
              <button
                class="rounded border px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
                data-testid="diag-export"
                @click="exportDiag"
              >
                إنشاء حزمة تشخيص
              </button>
              <button
                class="rounded border px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
                data-testid="open-shortcuts"
                @click="editorStore.shortcutsOpen = true"
              >
                اختصارات لوحة المفاتيح
              </button>
              <button
                class="rounded border px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
                data-testid="open-about"
                @click="editorStore.aboutOpen = true"
              >
                حول مِزَاج والتراخيص
              </button>
            </div>
            <p class="mt-1 text-xs text-slate-500">
              حزمة التشخيص ملف محلي (سجلات منقّاة وإصدارات وإعدادات، بلا نص مستنداتك)؛ لا يُرسل شيء
              عبر الشبكة.
            </p>
          </div>
          <div
            v-if="tab === 'general'"
            class="mt-4 border-t pt-3 text-sm dark:border-slate-700"
            data-testid="updates-section"
          >
            <h3 class="mb-2 font-semibold">التحديثات</h3>
            <label class="flex items-center gap-2">
              <input
                type="checkbox"
                :checked="settings.values.auto_update_check !== 'false'"
                data-testid="setting-auto-update"
                @change="
                  settings.update({
                    auto_update_check: String(($event.target as HTMLInputElement).checked)
                  })
                "
              />
              التحقق التلقائي من التحديثات
            </label>
            <p class="mt-1 text-xs text-slate-500">
              الاتصال الوحيد بالإنترنت: فحص إصدارات المشروع على GitHub فقط.
            </p>
            <button
              class="mt-2 rounded border px-3 py-1 hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-700"
              data-testid="update-check"
              @click="updater.check()"
            >
              التحقق من التحديثات
            </button>
            <p v-if="updateText" class="mt-2" data-testid="update-status">{{ updateText }}</p>
          </div>
          <DictionaryPanel v-else-if="tab === 'dictionary'" />
          <GlossaryPanel v-else-if="tab === 'glossary'" />
          <QuranSettings v-else-if="tab === 'quran'" />
          <OnlineSettings v-else-if="tab === 'online'" />
          <PacksSettings v-else-if="tab === 'packs'" />
          <BackupSettings v-else-if="tab === 'backup'" />
          <component :is="EditorQuality" v-else-if="tab === 'editor-quality' && EditorQuality" />
        </div>
      </Transition>
    </div>
  </div>
</template>
