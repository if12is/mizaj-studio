# Phase 5: التجميع الأوفلاين، اختبارات Playwright E2E، وآلية التحديث (Packaging, E2E & Updates)

**الهدف:** تجميع المحرك الخلفي مع كافة الاعتماديات المخفية في ملف تنفيذي مستقر، إجراء اختبارات تكامل شاملة عبر Playwright، وبناء مثبتات Windows و macOS مع دعم التحديثات الآمنة.

---

## Slice 5.1: تجميد محرك البايثون وتوثيق الاعتماديات المخفية (PyInstaller Freezing)
**الهدف:** إنتاج ملف تنفيذي مستقل (`mizaj-engine`) يعمل أوفلاين على أي جهاز.

### المهام (Tasks):
- [x] **Task 5.1.1:** إنشاء ملف التجميع `backend/mizaj_engine.spec` و `scripts/build_backend.py` باستخدام `PyInstaller` مع تحديد كافة **الاعتماديات والملفات المخفية (`hiddenimports` & `datas`)** المطلوبة لعمل `onnxruntime` و `mishkal` و `python-docx`:
  * `hiddenimports`: `['uvicorn.logging', 'uvicorn.loops.auto', 'uvicorn.protocols.http.auto', 'onnxruntime.capi._pybind_state', 'mishkal', 'qalsadi', 'tashaphyne', 'arramooz', 'pyarabic', 'libtashkeel', 'lxml._elementpath']`
  * `datas`: تضمين مجلد قواميس SQLite/Data الخاصة بـ `arramooz` و `mishkal`، وقوالب `python-docx` الافتراضية، وملف `models/catt_encoder_int8.onnx`.
- [x] **Task 5.1.2:** ضبط ميزانية الحجم الواقعية للمشروع:
  * حجم المحرك الخلفي بعد التجميع غير المضغوط (شاملاً `onnxruntime` ~80MB + نموذج `CATT INT8` ~42MB + قواميس `Mishkal/Arramooz` ~45MB + مفسر Python): يتراوح واقعياً بين **220MB إلى 280MB** (وبإضافة واجهة Electron يصبح الحجم الإجمالي بعد فك الضغط **~350MB**، وحجم ملف المثبت المضغوط `.exe`/`.dmg` حوالي **160MB - 210MB**).

---

## Slice 5.2: اختبارات التكامل الشاملة (Playwright E2E) وبناء المثبتات والتحديثات
**الهدف:** التحقق الآلي من دورة حياة التطبيق بالكامل وإنتاج نسخ التوزيع النهائية.

### المهام (Tasks):
- [x] **Task 5.2.1:** إعداد **اختبارات النهاية للنهاية (`Playwright for Electron` E2E)** في `desktop/tests/e2e/app.spec.ts` تختبر السيناريو الكامل آلياً:
  1. تشغيل تطبيق Electron والتحقق من اتصال `PythonProcessManager` وتحول شريط الحالة إلى "المحرك جاهز".
  2. استيراد ملف `backend/tests/fixtures/sample_ar.docx` و `sample_mixed.docx`.
  3. تنفيذ التشكيل والتحقق من ظهور الحركات في محرر CodeMirror 6 وبقاء الكلمات الإنجليزية (`iPhone 16 Pro`) دون تحريف.
  4. النقر على كلمة، تغيير تشكيلها من النافذة المنبثقة، وتصدير ملف `.docx` جديد والتحقق من وجوده على القرص.
- [x] **Task 5.2.2:** _(Windows NSIS يُبنى عبر GitHub Actions؛ DMG مُعدّ لكن لم يُختبر)_ إعداد `electron-builder.yml` لإنتاج مثبت `NSIS (.exe)` لويندوز و `DMG` لماك مع تضمين `mizaj-engine` داخل `extraResources`.
- [x] **Task 5.2.3:** _(قرار: الفحص التلقائي عبر GitHub Releases نُقل إلى Phase 6 بطلب المالك مع خيار تعطيله من الإعدادات؛ هذه المهمة تغطي حزمة `.mizajpack` الأوفلاين فقط)_ إضافة **آلية التحديث الهجينة الآمنة (Offline-First Update Mechanism)**:
  * التطبيق يعمل أوفلاين افتراضياً ولا يتصل بالإنترنت أبداً من تلقاء نفسه (Zero Background Telemetry).
  * داخل شاشة الإعدادات، يوجد زر يدوي صريح **"التحقق من وجود تحديثات (عبر GitHub Releases)"** باستخدام `electron-updater`، بالإضافة إلى خيار **"تحديث الحزمة/النماذج محلياً من ملف (`.mizajpack`)"** للمؤسسات والأجهزة المعزولة تماماً عن الإنترنت (Air-gapped PCs).
- [x] **Task 5.2.4:** تنفيذ اختبار الضغط النهائي على ملف `sample_long.txt` (35,380 كلمة / ~100 صفحة) والتأكد من استقرار استهلاك الذاكرة العشوائية تحت سقف `500MB`.
