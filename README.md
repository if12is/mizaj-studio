# مِزَاج (Mizaj Studio) — Open-Source Offline Arabic Diacritization Desktop Studio

**License:** `GPL-3.0-or-later` (see [`LICENSE`](./LICENSE))
**Node Version:** `20.11.0` (`.nvmrc`) | **Python Version:** `3.11.7` (`.python-version`)

**Mizaj Studio** is a high-performance, 100% offline, local-first desktop application for automatic Arabic text diacritization (Tashkeel) and non-destructive `.docx` document processing.

## Key Architectural Highlights (v2.0 Hardened Spec)
- **GPL-3.0 Open-Source Compliance:** Fully compatible with `mishkal` (`0.4.1`), `pyarabic` (`0.6.15`), `libtashkeel` (MIT), `onnxruntime` (MIT), `python-docx` (MIT), and `abjadai/catt` (Apache-2.0).
- **CodeMirror 6 Virtualized Editor + OpenType `COLR/CPAL` Font:** Renders 100+ page Arabic articles (35,000+ words) at 60 FPS with native viewport virtualization and zero-DOM-breakage colored diacritics (`font-palette`).
- **Resilient Local FastAPI Sidecar:** Binds strictly to `127.0.0.1` on an ephemeral port (`--port 0`), hides console windows on Windows (`windowsHide: true`), streams progress via **SSE**, and includes automatic crash recovery with exponential backoff and rotating logs.
- **Complete SQLite WAL Database + Migrations:** Includes `projects`, `documents`, `tashkeel_cache` (with `UNIQUE` index on `word_or_phrase`), `settings`, and `recent_files`, managed by a `PRAGMA user_version` migration runner.
- **Deep Non-Destructive DOCX Engine:** Preserves 7-tuple run style signatures, tables, headers/footers, footnotes/endnotes, textboxes (`w:txbxContent`), and mixed Arabic/English/Code spans.

## Repository Documentation Map
- **AI Agent Rules:** [`AGENTS.md`](./AGENTS.md) (Single Source of Truth), [`CLAUDE.md`](./CLAUDE.md), [`CONTRIBUTING.md`](./CONTRIBUTING.md)
- **Architecture Deep-Dives:**
  - [`docs/architecture/data-flow.md`](./docs/architecture/data-flow.md)
  - [`docs/architecture/threading-model.md`](./docs/architecture/threading-model.md)
  - [`docs/architecture/error-codes.md`](./docs/architecture/error-codes.md)
- **Implementation Phases & Vertical Slices:**
  - [`docs/plan/00_README_And_Brand_Identity.md`](./docs/plan/00_README_And_Brand_Identity.md)
  - [`docs/plan/01_Phase1_Foundation_And_Architecture.md`](./docs/plan/01_Phase1_Foundation_And_Architecture.md)
  - [`docs/plan/02_Phase2_Hybrid_Tashkeel_Engine.md`](./docs/plan/02_Phase2_Hybrid_Tashkeel_Engine.md)
  - [`docs/plan/03_Phase3_Docx_Preservation_Engine.md`](./docs/plan/03_Phase3_Docx_Preservation_Engine.md)
  - [`docs/plan/04_Phase4_Large_Scale_Interactive_UI.md`](./docs/plan/04_Phase4_Large_Scale_Interactive_UI.md)
  - [`docs/plan/05_Phase5_Offline_Packaging_And_Release.md`](./docs/plan/05_Phase5_Offline_Packaging_And_Release.md)
- **Test Fixtures:** `backend/tests/fixtures/` (`sample_ar.docx`, `sample_mixed.docx`, `sample_long.txt`)

## مميزات التطبيق

### التشكيل
- **محركان للتشكيل:** محرك سريع (mishkal) ومحرك دقيق (CATT بصيغة ONNX) يمكن التبديل بينهما.
- **مستويات التشكيل:** تشكيل كامل أو جزئي أو أدنى، إضافة إلى المستوى القانوني للمستندات الرسمية.
- **درجة ثقة لكل كلمة:** تُبرز الكلمات التي يتردد فيها المحرك لتراجعها يدوياً.
- **بث حي للنتائج:** يظهر التشكيل أثناء المعالجة مع إمكانية استئنافه إذا انقطع.
- **حماية الحروف الأصلية:** التشكيل يضيف الحركات أو يغيّرها فقط ولا يبدّل حروف النص أبداً.
- **مراجعة كلمة بكلمة:** مفتش الكلمات يعرض البدائل الممكنة، ويمكن قبول التغيير أو رفضه أو تعميمه على كل المواضع.
- **القاموس الشخصي والتعلّم من التصحيح:** يحفظ تشكيلاتك ويقترح الأسماء والأعلام المعتمدة.
- **الإعراب والشعر:** شرح إعراب الكلمة، ووضع خاص للشعر والعروض.

### الإملاء والتدقيق
- **اقتراحات فقط:** التدقيق لا يغيّر حروف النص تلقائياً، وكل تصحيح يقبله المستخدم بنفسه.
- **مدقق معجمي:** يعتمد على قاموس Hunspell/ayaspell العربي.
- **أنماط الأخطاء الشائعة:** يكشف الهمزات والتاء المربوطة والترقيم والمسافات العربية.
- **مؤشر المقروئية:** تقدير سهولة القراءة بمقياس OSMAN وتلميحات أسلوبية.
- **تطبيع الكتابة:** توحيد التطويل والأرقام والرموز الطباعية.
- **LanguageTool اختياري:** تكامل مع أداة محلية للقواعد النحوية إن كانت مثبتة على جهازك.

### القرآن الكريم
- **نص القرآن من Tanzil:** يُنزَّل اختيارياً بترخيص CC BY 3.0 ويُتحقق من سلامته قبل الاعتماد.
- **حماية الآيات:** تُكتشف الآيات في النص وتُعامل بنصها المعتمد دون عبث.

### الأدوات القانونية والرسمية
- **التفقيط:** كتابة المبالغ بالحروف لـ 18 عملة.
- **التواريخ:** كتابة التواريخ الهجرية والميلادية بالحروف.
- **المصطلحات المعرَّفة:** فحص اتساق الأطراف والمصطلحات داخل العقد.
- **البنود والإحالات:** ترقيم البنود والتحقق من الإحالات الداخلية.
- **مسرد قانوني:** قاموس مصطلحات يضمن توحيد الصياغة.
- **18 قالباً جاهزاً:** عقود ومستندات بمتغيرات قابلة للتعبئة.
- **فاحص الصياغة:** ينبّه إلى العبارات الغامضة وأخطاء الصياغة القانونية.
- **الاستشهادات:** التحقق من الإحالات إلى القوانين والآيات.
- **الحجب والتعمية:** إخفاء البيانات الشخصية قبل مشاركة المستند.
- **مقارنة النسخ:** مقارنة نسختين من العقد بمعزل عن اختلاف التشكيل.

### الملفات والاستيراد والتصدير
- **DOCX مع حفظ التنسيق:** يشمل الجداول والحواشي والتعليقات، ويحفظ الملف ذرياً دون إتلافه.
- **تتبّع التغييرات:** تصدير Word تظهر فيه التعديلات كتغييرات متتبَّعة.
- **صيغ متعددة:** استيراد وتصدير TXT وMarkdown وSRT وEPUB وPDF.
- **معالجة المجلدات:** تشكيل مجلد كامل من الملفات دفعة واحدة.
- **OCR أوفلاين:** قراءة المستندات الممسوحة عبر Tesseract المحلي.
- **اللصق من Word:** يحافظ على التنسيق عند اللصق.

### المحرر والواجهة
- **محرك CodeMirror 6:** يتحمل المستندات الطويلة (نحو 100 صفحة) مع دعم كامل للكتابة من اليمين إلى اليسار.
- **تلوين الحركات:** عرض الحركات بألوان مميزة بخط مخصص.
- **المقارنة والمراجعة:** عرض الفروق جنباً إلى جنب وشريط لقبول التعديلات أو رفضها.
- **بحث واستبدال:** يراعي التشكيل ويعمل على النص كله.
- **إحصائيات فورية:** عدد الكلمات وكثافة الحركات والكلمات المشكولة.
- **القراءة الصوتية:** قراءة النص المشكول بصوت مسموع عند توفر صوت عربي في النظام.
- **سهولة الوصول:** تكبير وتصغير، وتباين عالٍ، واختصارات لوحة مفاتيح، ودعم قارئات الشاشة.
- **حفظ تلقائي:** يحفظ عملك بعد توقفك عن الكتابة، وتبقى الجلسات محفوظة.

### الخصوصية والعمل دون إنترنت
- **أوفلاين أولاً:** كل المزايا الأساسية تعمل دون اتصال بالإنترنت.
- **بلا حسابات ولا خادم:** لا تسجيل دخول ولا مزامنة سحابية ولا تتبّع.
- **المشاركة بالملفات:** تصدير واستيراد حزم `.mizajpack` (قاموس، مسرد، قوالب، إعدادات) مع معاينة التعارض.
- **ميزات الإنترنت اختيارية:** مغلقة افتراضياً، وتوضح ما الذي يغادر جهازك إن وُجد.
- **مساعد Gemini (اختياري، معطّل افتراضياً):** اسأل عن المستند أو عن إعراب كلمة وقاعدتها بمفتاح Google AI Studio الخاص بك (يُحفظ مشفّراً بمخزن النظام ولا يظهر في الواجهة)، أو عبر Gemini CLI المثبّت على جهازك بحسابك وحدوده. يُرسَل إلى Google النص المحدد أو مقتطف المستند مع سؤالك فقط عند طرحه وبعد موافقتك الأولى؛ والمساعد يقترح أو يؤكد شكّاً ولا يعدّل مستندك، ولا يُطبَّق أي اقتراح تشكيل إلا بضغطتك وبشرط ألا تتغير الحروف الأصلية.
- **أدوات محلية:** تكامل اختياري مع خادم LanguageTool المحلي للتدقيق النحوي.
- **لوحات جانبية مرنة:** اسحب حافة لوحة «قائمة الأخطاء الإملائية» (أو استخدم الأسهم) لتغيير عرضها، واطوِها، أو ثبّتها أسفل المحرر؛ ويُحفظ اختيارك.
- **تنزيل موارد مجانية:** قواميس ونص القرآن بتنزيل قابل للاستئناف مع التحقق من الحجم والبصمة.
- **نسخ احتياطي:** نسخة كاملة محلية يمكن استعادتها في أي وقت.

### التحديث والأمان
- **تحديث تلقائي:** من إصدارات GitHub، ويمكن إيقافه من الإعدادات، ويعمل في النسخة المثبّتة فقط.
- **حزم نماذج أوفلاين:** للأجهزة المعزولة عن الشبكة.
- **رمز وصول لكل تشغيل:** المحرك المحلي يقبل الطلبات المصرّح بها فقط، ويمنع هجمات DNS rebinding.
- **قراءة آمنة للملفات:** حماية من XXE وقنابل الضغط، والتحقق من مسارات الملفات.
- **نوافذ معزولة:** عزل السياق وSandbox وIPC موثّق وتقوية Electron.
- **تعافٍ من الأعطال:** إعادة تشغيل المحرك تلقائياً وتسجيل محلي دون إرسال أي بيانات.
