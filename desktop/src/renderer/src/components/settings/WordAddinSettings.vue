<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useWordAddinStore } from '@renderer/stores/wordaddin'

const wa = useWordAddinStore()
onMounted(() => void wa.load())

const consent = ref(false)
const st = computed(() => wa.state)
const supported = computed(() => st.value?.supported ?? false)
const btn =
  'rounded border px-3 py-1 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-700'

const certText = computed(() => {
  const c = st.value?.cert
  if (!c || !c.exists) return 'لم تُنشأ بعد'
  if (c.expired) return 'منتهية الصلاحية'
  const until = c.notAfter ? new Date(c.notAfter).toLocaleDateString('ar') : ''
  const trust =
    c.trusted === null ? 'تعذّر فحص الثقة' : c.trusted ? 'موثوقة في ويندوز' : 'غير موثوقة بعد'
  return `${trust} · تنتهي ${until}${c.needsRenewal ? ' (جدّدها بإعادة التثبيت)' : ''}`
})

const LEVEL: Record<WordAddinCheck['level'], string> = { ok: '✔', warn: '⚠', fail: '✘' }
</script>

<template>
  <div class="space-y-5 text-sm" data-testid="wordaddin-settings">
    <section class="space-y-2 rounded border p-3 dark:border-slate-600" data-testid="wa-explainer">
      <h3 class="text-base font-semibold">إضافة Word («مِزَاج» في شريط Word)</h3>
      <p>
        تضيف تبويباً باسم «مِزَاج» في شريط Microsoft Word فيه أزرار «إملائي» و«ترقيم» و«تشكيل»
        و«الكل»، ولوحة جانبية فيها معاينة وزر «استبدال». تعالج التحديد عبر محرك مِزَاج على جهازك
        وتكتب النتيجة في Word <b>بأصغر تعديلات على الحروف</b> فيبقى تنسيق كل حرف كما هو.
      </p>
      <ul class="list-disc space-y-1 ps-5 text-xs text-slate-600 dark:text-slate-300">
        <li>
          تعمل عبر عنوان محلي آمن <span dir="ltr">https://localhost</span> يخدمه مِزَاج نفسه، فيجب
          أن يكون مِزَاج <b>مفتوحاً</b> أثناء استعمالها. المعالجة كلها على جهازك دون إنترنت، ولا
          خادم لنا ولا حسابات ولا يخرج نصك من جهازك.
        </li>
        <li>
          يطلب Word أن يكون العنوان https، لذلك ينشئ مِزَاج شهادة خاصة بجهازك فقط (لا تصلح لأي موقع
          آخر) ويضيفها <b>بموافقتك</b> إلى الشهادات الموثوقة للمستخدم الحالي؛ وسيعرض ويندوز نافذة
          تأكيد خاصة به. تُحذف عند إلغاء التثبيت.
        </li>
        <li>
          تحمّل الصفحة مكتبة Office.js من مايكروسوفت (<span dir="ltr"
            >appsforoffice.microsoft.com</span
          >) أول مرة، وهذا الاتصال يجريه Word لا مِزَاج ولا يحمل أي نص. بعدها تُحفظ في ذاكرة Word
          المؤقتة قدر الإمكان.
        </li>
      </ul>
    </section>

    <p
      v-if="st && !supported"
      class="rounded border border-mizaj-amber p-2 text-xs"
      data-testid="wa-unsupported"
    >
      هذه الميزة تعمل على ويندوز فقط، وهي غير متاحة على هذا النظام.
    </p>

    <section class="space-y-2" data-testid="wa-switch">
      <h3 class="font-semibold">التفعيل</h3>
      <div class="rounded border p-2 dark:border-slate-600">
        <label class="flex items-center gap-2 font-semibold">
          <input
            type="checkbox"
            role="switch"
            data-testid="wa-enabled"
            :checked="st?.enabled ?? false"
            :disabled="!supported || wa.busy"
            @change="wa.setEnabled(($event.target as HTMLInputElement).checked)"
          />
          تفعيل إضافة Word
        </label>
        <p class="text-xs text-slate-500">
          معطّلة افتراضياً: لا منفذ يُفتح ولا شهادة تُنشأ قبل تفعيلك. التفعيل يشغّل الخادم المحلي
          فقط؛ وللتثبيت في Word اضغط «تثبيت» أدناه.
        </p>
      </div>
      <p v-if="st?.error" class="text-xs text-red-500" role="alert" data-testid="wa-error">
        {{ st.error }}
      </p>
    </section>

    <section class="space-y-2" data-testid="wa-status">
      <h3 class="font-semibold">الحالة</h3>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
        <dt>الخادم المحلي</dt>
        <dd data-testid="wa-running">
          {{ st?.running ? `يعمل على https://localhost:${st.port}` : 'متوقف' }}
        </dd>
        <dt>الشهادة</dt>
        <dd data-testid="wa-cert">{{ certText }}</dd>
        <dt>التثبيت في Word</dt>
        <dd data-testid="wa-installed">{{ st?.installed ? 'مثبّتة' : 'غير مثبّتة' }}</dd>
      </dl>
    </section>

    <section class="space-y-2" data-testid="wa-install">
      <h3 class="font-semibold">التثبيت</h3>
      <label class="flex items-start gap-2 text-xs">
        <input
          v-model="consent"
          type="checkbox"
          data-testid="wa-consent"
          :disabled="!supported || !st?.enabled"
        />
        <span>
          أوافق على إضافة شهادة <span dir="ltr">https://localhost</span> الخاصة بهذا الجهاز إلى
          «الشهادات الجذر الموثوقة» للمستخدم الحالي، وعلى تسجيل الإضافة في Word. (تحتاج ضغط «نعم» في
          نافذة ويندوز.)
        </span>
      </label>
      <div class="flex flex-wrap gap-2">
        <button
          :class="btn"
          type="button"
          data-testid="wa-install-btn"
          :disabled="!supported || !st?.enabled || !consent || wa.busy"
          @click="wa.install()"
        >
          تثبيت إضافة Word
        </button>
        <button
          :class="btn"
          type="button"
          data-testid="wa-uninstall-btn"
          :disabled="!supported || !st?.installed || wa.busy"
          @click="wa.uninstall()"
        >
          إلغاء التثبيت
        </button>
        <button
          :class="btn"
          type="button"
          data-testid="wa-test-btn"
          :disabled="!supported || !st?.enabled || wa.busy"
          @click="wa.test()"
        >
          تحقق
        </button>
        <button
          :class="btn"
          type="button"
          data-testid="wa-open-catalog"
          :disabled="!supported || wa.busy"
          @click="wa.openCatalog()"
        >
          فتح مجلد الإضافة
        </button>
      </div>

      <ul v-if="wa.steps.length" class="space-y-1 text-xs" data-testid="wa-steps">
        <li
          v-for="s in wa.steps"
          :key="s.id"
          :class="s.ok ? '' : 'text-red-500'"
          :data-testid="`wa-step-${s.id}`"
        >
          {{ s.ok ? '✔' : '✘' }} {{ s.text }}
        </li>
      </ul>
      <ul v-if="wa.checks.length" class="space-y-1 text-xs" data-testid="wa-checks">
        <li
          v-for="c in wa.checks"
          :key="c.id + c.text"
          :class="c.level === 'fail' ? 'text-red-500' : c.level === 'warn' ? 'text-amber-600' : ''"
          :data-testid="`wa-check-${c.id}`"
          :data-level="c.level"
        >
          {{ LEVEL[c.level] }} {{ c.text }}
        </li>
      </ul>
    </section>

    <section
      class="space-y-1 rounded border p-3 text-xs dark:border-slate-600"
      data-testid="wa-steps-guide"
    >
      <h3 class="text-sm font-semibold">بعد التثبيت: خطوات في Word</h3>
      <ol class="list-decimal space-y-1 ps-5 text-slate-600 dark:text-slate-300">
        <li>أغلق Word كاملاً (كل النوافذ) ثم افتحه من جديد.</li>
        <li>
          إن لم يظهر تبويب «مِزَاج»: «إدراج» ← «الوظائف الإضافية» ← «إضافاتي» ← «الوظائف الإضافية
          للمطوّر» ← «مِزَاج».
        </li>
        <li>حدّد نصاً عربياً واضغط «إملائي» أو «ترقيم» أو «تشكيل» أو «الكل» من تبويب «مِزَاج».</li>
        <li>للمعاينة قبل الاستبدال استعمل زر «معاينة واستبدال» (اللوحة الجانبية).</li>
        <li>اضغط «تحقق» هنا إن لم تعمل الأزرار؛ سيخبرك أي خطوة ناقصة.</li>
      </ol>
      <p class="pt-1">
        طريقة بديلة يدوية (مجلد مشترك موثوق) ومعلومات أوسع ومحدودياتها في الدليل: «الإضافة لـ Word».
      </p>
    </section>
  </div>
</template>
