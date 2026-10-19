<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useSystemwideStore } from '@renderer/stores/systemwide'
import { acceleratorFromEvent } from '@renderer/lib/accelerator'

const sw = useSystemwideStore()
onMounted(() => void sw.load())

const SHORTCUTS: { id: SystemwideShortcutId; label: string; help: string }[] = [
  {
    id: 'main',
    label: 'النافذة الصغيرة',
    help: 'تفتح نافذة صغيرة قرب المؤشر فيها أزرار الإجراءات الأربعة ومعاينة النتيجة.'
  },
  { id: 'proofread', label: 'تدقيق إملائي', help: 'الهمزات والإملاء والياء فقط.' },
  { id: 'punctuation', label: 'ترقيم', help: 'مسافات علامات الترقيم وعلاماتها فقط.' },
  {
    id: 'tashkeel',
    label: 'تشكيل',
    help: 'التشكيل فقط، بمحركك ومستواك الافتراضيين من الإعدادات.'
  },
  { id: 'all', label: 'الكل', help: 'تدقيق ثم ترقيم ثم تشكيل، بهذا الترتيب.' }
]

const cfg = computed(() => sw.state?.config)
const supported = computed(() => sw.state?.supported ?? false)
const field =
  'w-44 rounded border px-2 py-1 text-center font-mono dark:border-slate-600 dark:bg-slate-800'
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'

function record(id: SystemwideShortcutId, e: KeyboardEvent): void {
  if (e.key === 'Tab') return // keep keyboard navigation
  e.preventDefault()
  const acc = acceleratorFromEvent(e)
  if (acc) void sw.update({ shortcuts: { [id]: acc } })
}

const STATE_LABEL = {
  registered: 'مفعّل',
  conflict: 'تعارض',
  invalid: 'غير صالح',
  off: ''
} as const
</script>

<template>
  <div class="space-y-5 text-sm" data-testid="systemwide-settings">
    <section class="space-y-2 rounded border p-3 dark:border-slate-600" data-testid="sw-explainer">
      <h3 class="text-base font-semibold">مِزَاج في أي برنامج</h3>
      <p>
        حدّد نصاً عربياً في أي برنامج على ويندوز (Word أو المتصفح أو المفكرة…) ثم اضغط اختصاراً
        عاماً، فيُدقَّق النص أو يُرقَّم أو يُشكَّل ويُوضَع مكانه <b>مع الحفاظ على تنسيقه</b> (الخطوط
        والألوان والأحجام وأنماط الفقرات).
      </p>
      <ul class="list-disc space-y-1 ps-5 text-xs text-slate-600 dark:text-slate-300">
        <li>
          <b>في Word:</b> يُعدَّل التحديد مباشرة عبر Word نفسه بأصغر تعديلات ممكنة (حركة تُضاف أو
          حرف يُصحَّح) فيبقى تنسيق كل حرف كما هو، وتُلغى كلها بضغطة
          <span dir="ltr">Ctrl+Z</span> واحدة.
        </li>
        <li>
          <b>في بقية البرامج:</b> يُنسخ التحديد ثم تُعدَّل نصوصه فقط داخل النسخة الغنية (HTML) فتبقى
          الوسوم والأنماط كما هي، ثم يُلصق مكانه وتُعاد حافظتك السابقة كما كانت.
        </li>
        <li>
          <b>الخصوصية:</b> كل شيء يجري على جهازك دون إنترنت. لا يُحفظ النص ولا يُسجَّل، ويُحذف أي
          ملف مؤقت فور انتهاء العملية.
        </li>
        <li>
          الهمزات والإملاء اقتراحات تُطبَّق بضغطك أنت على الاختصار؛ لا يتغير حرف أساسي بغير ذلك،
          والتشكيل لا يغيّر الحروف أبداً.
        </li>
      </ul>
    </section>

    <p
      v-if="sw.state && !supported"
      class="rounded border border-mizaj-amber p-2 text-xs"
      data-testid="sw-unsupported"
    >
      هذه الميزة تعمل على ويندوز فقط، وهي غير متاحة على هذا النظام.
    </p>

    <section class="space-y-3" data-testid="sw-switches">
      <h3 class="font-semibold">التفعيل</h3>
      <div class="rounded border p-2 dark:border-slate-600">
        <label class="flex items-center gap-2 font-semibold">
          <input
            type="checkbox"
            role="switch"
            data-testid="sw-enabled"
            :checked="cfg?.enabled ?? false"
            :disabled="!supported || sw.busy"
            @change="sw.update({ enabled: ($event.target as HTMLInputElement).checked })"
          />
          تفعيل «مِزَاج في أي برنامج»
        </label>
        <p class="text-xs text-slate-500">
          معطّل افتراضياً. عند التفعيل تُحجز الاختصارات أدناه على مستوى النظام، وتعمل ما دام مِزَاج
          مفتوحاً. إيقاف الخيار أو إغلاق التطبيق يُحرّر الاختصارات فوراً.
        </p>
      </div>
      <div class="rounded border p-2 dark:border-slate-600">
        <label class="flex items-center gap-2 font-semibold">
          <input
            type="checkbox"
            role="switch"
            data-testid="sw-background"
            :checked="cfg?.runInBackground ?? false"
            :disabled="!supported || sw.busy"
            @change="sw.update({ runInBackground: ($event.target as HTMLInputElement).checked })"
          />
          تشغيل في الخلفية
        </label>
        <p class="text-xs text-slate-500">
          عند إغلاق النافذة يبقى مِزَاج في منطقة الإشعارات (علبة النظام) فتبقى الاختصارات تعمل.
          للخروج الكامل اختر «خروج» من قائمة أيقونته. بدون هذا الخيار يُغلق التطبيق وتتوقف
          الاختصارات بإغلاق النافذة.
        </p>
      </div>
    </section>

    <section class="space-y-2" data-testid="sw-mode">
      <h3 class="font-semibold">طريقة الاستبدال</h3>
      <label class="flex items-start gap-2">
        <input
          type="radio"
          name="sw-mode"
          value="preview"
          data-testid="sw-mode-preview"
          :checked="cfg?.replaceMode !== 'direct'"
          :disabled="!supported || sw.busy"
          @change="sw.update({ replaceMode: 'preview' })"
        />
        <span>
          <b>معاينة أولاً</b> (الافتراضي)
          <span class="block text-xs text-slate-500">
            تظهر نافذة صغيرة بنتيجة المعالجة مع إبراز التغييرات، ولا يتغير نصك إلا بزر «استبدال» أو
            Enter.
          </span>
        </span>
      </label>
      <label class="flex items-start gap-2">
        <input
          type="radio"
          name="sw-mode"
          value="direct"
          data-testid="sw-mode-direct"
          :checked="cfg?.replaceMode === 'direct'"
          :disabled="!supported || sw.busy"
          @change="sw.update({ replaceMode: 'direct' })"
        />
        <span>
          <b>استبدال مباشر</b>
          <span class="block text-xs text-slate-500">
            يُستبدل النص فور الضغط على الاختصار دون معاينة. في Word يمكنك التراجع بـ
            <span dir="ltr">Ctrl+Z</span>.
          </span>
        </span>
      </label>
    </section>

    <section class="space-y-2" data-testid="sw-shortcuts">
      <h3 class="font-semibold">الاختصارات</h3>
      <p class="text-xs text-slate-500">
        انقر داخل الخانة ثم اضغط الاختصار الجديد (يلزم Ctrl أو Alt مع مفتاح). لكل إجراء اختصار
        اختياري؛ اتركه فارغاً لتعطيله. إن كان الاختصار مستعملاً في برنامج آخر ستظهر رسالة تعارض.
      </p>
      <div
        v-for="s in SHORTCUTS"
        :key="s.id"
        class="rounded border p-2 dark:border-slate-600"
        :data-testid="`sw-row-${s.id}`"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="min-w-28 font-semibold">{{ s.label }}</span>
          <input
            :class="field"
            dir="ltr"
            readonly
            :value="cfg?.shortcuts[s.id] ?? ''"
            :placeholder="cfg?.shortcuts[s.id] ? '' : 'بدون اختصار'"
            :disabled="!supported"
            :aria-label="`اختصار ${s.label}`"
            :data-testid="`sw-shortcut-${s.id}`"
            @keydown="record(s.id, $event)"
          />
          <button
            :class="btn"
            type="button"
            :disabled="!supported || !cfg?.shortcuts[s.id]"
            :data-testid="`sw-clear-${s.id}`"
            @click="sw.update({ shortcuts: { [s.id]: '' } })"
          >
            مسح
          </button>
          <span
            v-if="sw.state?.shortcuts[s.id].state && sw.state.shortcuts[s.id].state !== 'off'"
            class="rounded px-2 py-0.5 text-xs"
            :class="
              sw.state.shortcuts[s.id].state === 'registered'
                ? 'bg-mizaj-emerald/20'
                : 'bg-mizaj-amber/30'
            "
            :data-testid="`sw-status-${s.id}`"
          >
            {{ STATE_LABEL[sw.state.shortcuts[s.id].state] }}
          </span>
        </div>
        <p class="mt-1 text-xs text-slate-500">{{ s.help }}</p>
        <p
          v-if="sw.state?.errors[s.id] || sw.state?.shortcuts[s.id].message"
          class="mt-1 text-xs text-red-500"
          role="alert"
          :data-testid="`sw-error-${s.id}`"
        >
          {{ sw.state?.errors[s.id] || sw.state?.shortcuts[s.id].message }}
        </p>
      </div>
    </section>

    <section
      class="space-y-1 rounded border p-3 text-xs dark:border-slate-600"
      data-testid="sw-limits"
    >
      <h3 class="text-sm font-semibold">ملاحظات وحدود</h3>
      <ul class="list-disc space-y-1 ps-5 text-slate-600 dark:text-slate-300">
        <li>
          البرامج التي تعمل بصلاحيات المسؤول (Administrator) لا يستطيع ويندوز التحكم بها من برنامج
          عادي؛ ستظهر رسالة توضح ذلك. ونوافذ الطرفية (cmd وPowerShell) غير مدعومة.
        </li>
        <li>
          إن لم يُنسخ أي نص تظهر رسالة «لم يُنسخ أي نص محدد». حدّد النص أولاً، واترك مفاتيح الاختصار
          قبل أن يبدأ النسخ.
        </li>
        <li>
          النص القصير (أقل من 4 كلمات) يُنبَّه إليه عند التشكيل: السياق ضعيف فتقلّ دقة الحركات.
        </li>
        <li>
          في Word: مستندات «العرض المحمي» أو المحمية من التحرير لا تُعدَّل. والتحديد الذي فيه حقول
          أو جداول أو أشكال يُعالَج عبر الحافظة بدل التعديل المباشر لتجنب إفساد المستند.
        </li>
        <li>الآيات القرآنية في التحديد محمية فلا تُصحَّح.</li>
      </ul>
    </section>
  </div>
</template>
