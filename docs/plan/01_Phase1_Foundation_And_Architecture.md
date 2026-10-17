# Phase 1: البنية التحتية، معمارية المحرر، وقاعدة البيانات الكاملة (Foundation & Core Architecture)

**الهدف:** تأسيس مشروع Electron + Vue 3 مع حسم التحديات المعمارية مبكراً (CodeMirror 6 Virtual Scrolling + OpenType COLR/CPAL Colored Diacritics)، وإعداد خادم Python المحلي الآمن مع نظام التعافي من الأعطال، وقاعدة بيانات SQLite شاملة مع نظام Migrations وشاشة الإعدادات.

---

## Slice 1.1: تهيئة Electron + Vue 3 + إثبات مفهوم المحرر وتلوين الحركات (Editor & Font PoC)
**الهدف:** بناء واجهة RTL نظيفة وحسم معمارية التمرير الافتراضي وتلوين الحركات من اليوم الأول قبل Phase 4.

### المهام (Tasks):
- [ ] **Task 1.1.1:** إنشاء المشروع داخل `desktop/` باستخدام `electron-vite` مع `Vue 3 (Composition API)`، `Pinia`، `TypeScript`، وتثبيت إصدار Node `20.11.0` في `.nvmrc` و `package.json` (`engines`)، مع إعداد `ESLint` و `Prettier`.
- [ ] **Task 1.1.2:** إعداد `Tailwind CSS` باتجاه `dir="rtl" lang="ar"`، وتضمين خط `Cairo` للواجهة، وبناء/تضمين خط **`Amiri-Mizaj-Colr.woff2`** المدعوم بجدول **OpenType `COLR/CPAL`** بحيث يتم تلوين الحركات (`ً`–`ْ`) عبر خاصية CSS `font-palette: --mizaj-colored` دون استخدام `<span>` أو `ZWJ` يكسر شكل الحروف المتصلة أو النسخ.
- [ ] **Task 1.1.3:** دمج **`CodeMirror 6` (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands`)** كمحرر أساسي منذ المرحلة الأولى (بدلاً من TipTap/ProseMirror غير المتوافق مع Virtual Scrolling)، والتحقق من دعمه لعرض 35,000 كلمة (`sample_long.txt`) عبر Viewport Virtualization بسرعة 60 FPS مع اتجاه RTL.
- [ ] **Task 1.1.4:** تصميم النافذة المخصصة (`Frameless Window`) مع شريط عنوان RTL، القائمة الجانبية للمجلدات والمشاريع، مساحة المحرر، وشريط الحالة السفلي.

---

## Slice 1.2: المحرك الخلفي المدمج، المنفذ الديناميكي، والتعافي من الأعطال (Sidecar & Crash Recovery)
**الهدف:** تشغيل سيرفر Python محلي صامت وآمن على `127.0.0.1` مع آلية إعادة تشغيل تلقائي ونظام Logging موحد.

### المهام (Tasks):
- [ ] **Task 1.2.1:** إعداد `backend/` بإصدار Python `3.11.7` (`.python-version`)، وأداة الفحص `Ruff`، وملف `requirements.txt` بإصدارات مثبتة بـ `==` (`fastapi==0.110.0`, `uvicorn==0.28.0`, `pydantic==2.6.4`, `pyarabic==0.6.15`, `mishkal==0.4.1`, `libtashkeel==0.1.5`, `onnxruntime==1.17.1`, `python-docx==1.1.0`, `lxml==5.1.0`, `pytest==8.1.1`).
- [ ] **Task 1.2.2:** برمجة `backend/app/main.py` ليربط السيرفر حصرياً على العنوان المحلي **`127.0.0.1`** مع تمرير `--port 0` ليقوم نظام التشغيل بتخصيص منفذ فارغ تلقائياً، ثم طباعة السطر `MIZAJ_PORT=<assigned_port>` على `stdout` مع `flush=True`.
- [ ] **Task 1.2.3:** برمجة `PythonProcessManager` في `desktop/src/main/pythonManager.ts` باستخدام `child_process.spawn` مع تفعيل الخيار الإلزامي **`windowsHide: true`** (لمنع ظهور نافذة CMD سوداء على ويندوز)، وقراءة منفذ `MIZAJ_PORT` من `stdout`.
- [ ] **Task 1.2.4:** تطبيق استراتيجية **التعافي من الأعطال (Crash Recovery)** في `PythonProcessManager`: مراقبة حدث `exit`، وإذا انهار المحرك الخلفي بشكل غير متوقع، يتم إعادة تشغيله تلقائياً بتأخير تدريجي (Exponential Backoff: `1s`, `2s`, `4s` بحد أقصى 3 محاولات) مع إشعار الواجهة عبر IPC، وضمان قتله نهائياً عند `will-quit`.
- [ ] **Task 1.2.5:** إعداد نظام **التسجيل الموحد وتدوير الملفات (Unified Logging & Log Rotation)**: حفظ اللوجات في `<userData>/logs/mizaj-main.log` و `mizaj-backend.log` بمستويات (`DEBUG`, `INFO`, `WARN`, `ERROR`) مع `RotatingFileHandler` (بحد أقصى `5MB` للملف و `5` نسخ احتياطية).

---

## Slice 1.3: قاعدة بيانات SQLite الكاملة ونظام الترقيات (Database Schema & Migrations)
**الهدف:** تصميم مخطط قاعدة بيانات متكامل يدعم المشاريع، الكاش الذكي، الإعدادات، والملفات الأخيرة مع نظام Migrations آمن.

### المهام (Tasks):
- [ ] **Task 1.3.1:** إعداد مدير اتصال `SQLite` في `backend/app/core/database.py` مع تفعيل `PRAGMA journal_mode=WAL;`، `PRAGMA synchronous=NORMAL;`، `PRAGMA foreign_keys=ON;`، و `PRAGMA busy_timeout=5000;`.
- [ ] **Task 1.3.2:** بناء محرك ترقية قاعدة البيانات (**SQLite Migration Runner**) بالاعتماد على `PRAGMA user_version` وسكربتات ترقية متسلسلة (`migrations/001_initial.sql`, `002_...`) مع أخذ نسخة احتياطية تلقائية من ملف `.db` قبل تنفيذ أي ترقية جديدة.
- [ ] **Task 1.3.3:** إنشاء الجداول الكاملة في الترقية الأولى (`001_initial.sql`):
  1. جدول **`projects`**: (`id`, `name`, `description`, `created_at`, `updated_at`).
  2. جدول **`documents`**: (`id`, `project_id` FK, `title`, `raw_content`, `diacritized_content`, `source_docx_path`, `language`, `direction` DEFAULT 'rtl', `word_count`, `is_deleted` INTEGER DEFAULT 0, `created_at`, `updated_at`).
  3. جدول **`tashkeel_cache`**: (`id`, `word_or_phrase` TEXT NOT NULL, `diacritized_form` TEXT NOT NULL, `source` TEXT CHECK(source IN ('user', 'engine', 'dictionary')) DEFAULT 'engine', `is_user_locked` INTEGER DEFAULT 0, `usage_count` INTEGER DEFAULT 1, `created_at`, `updated_at`) مع إضافة فهرس فريد إلزامي: **`CREATE UNIQUE INDEX idx_cache_word_unique ON tashkeel_cache(word_or_phrase);`**.
  4. جدول **`settings`**: (`key` TEXT PRIMARY KEY, `value` TEXT NOT NULL, `updated_at`).
  5. جدول **`recent_files`**: (`id`, `file_path` UNIQUE, `document_id` FK, `last_opened_at`).
- [ ] **Task 1.3.4:** برمجة الحفظ التلقائي الذكي (**Smart Debounced Auto-Save**) في الواجهة: يحفظ بعد **5 ثوانٍ** من توقف الكتابة لتقليل استهلاك أقراص SSD، مع حفظ فوري إجباري (`flush`) عند إغلاق البرنامج أو تبديل المستند أو فقدان تركيز النافذة (`window.onblur`).

---

## Slice 1.4: شاشة الإعدادات وإدارة القاموس الشخصي (Settings & Personal Dictionary UI)
**الهدف:** تمكين المستخدم من تخصيص سلوك المحرك، المظهر، وإدارة كلماته المحفوظة منذ البداية.

### المهام (Tasks):
- [ ] **Task 1.4.1:** بناء مسارات API للإعدادات (`GET /api/settings`, `PUT /api/settings`) وإدارة القاموس الشخصي (`GET /api/dictionary`, `POST /api/dictionary`, `DELETE /api/dictionary/{id}`).
- [ ] **Task 1.4.2:** تصميم نافذة الإعدادات والتفضيلات في الواجهة وتشمل:
  * الوضع الافتراضي للتشكيل (`fast` عبر Libtashkeel أو `accurate` عبر CATT ONNX).
  * مستوى التشكيل الافتراضي (`full` كامل، `irab_only` أواخر الكلمات، `minimal` فك اللبس).
  * إعدادات المحرر (نوع الخط، حجم الخط، تفعيل/تعطيل تلوين الحركات، السمة الليلية/النهارية).
- [ ] **Task 1.4.3:** بناء مدير القاموس الشخصي داخل الإعدادات (بحث، إضافة كلمة مشكولة يدوياً، تعديل، حذف، واستيراد/تصدير القاموس كملف JSON).
