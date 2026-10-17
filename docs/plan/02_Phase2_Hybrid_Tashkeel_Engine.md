# Phase 2: بناء محرك التشكيل الهجين، خيوط المعالجة، ووضع المحاكاة (Hybrid Tashkeel Engine)

**الهدف:** دمج `libtashkeel` و `CATT ONNX INT8` و `mishkal` في خط أنابيب متوازي آمن للخيوط (Thread-safe)، مع بث التقدم عبر `SSE` وتوفير وضع `Mock Mode` القياسي للاختبارات السحابية.

---

## Slice 2.1: التنظيف، حماية التشكيل الجزئي، والتقطيع المبني على طول النموذج (Smart Chunker)
**الهدف:** تقسيم المقالات الضخمة بما يتوافق علمياً مع سعة نموذج CATT (512 محرفاً) دون كسر الجمل.

### المهام (Tasks):
- [x] **Task 2.1.1:** استخدام `pyarabic` لتنظيف النص وتوحيد الهمزات، مع بناء آلية **`PartialDiacritizationLock`** التي تحفظ مواقع الحركات التي وضعها الكاتب بنفسه قبل التشكيل لتثبيتها بعد خروج النص من النموذج.
- [x] **Task 2.1.2:** بناء مقسم الجمل الذكي (`ArabicSentenceSplitter`) بحد أقصى **`256` حرفاً للقطعة الواحدة**؛ والسبب التقني هو أن نموذج `CATT` يعتمد على Character-level Transformer بنافذة سياق قصوى تبلغ `512` رمزاً (شاملة الحروف والحركات المضافة وعلامات البداية والنهاية `[BOS]/[EOS]`)، مما يجعل سقف 256 حرفاً خام آمناً تماماً من أي اقتطاع (Truncation).
- [x] **Task 2.1.3:** بناء خريطة الاسترجاع (`ChunkMap`) لإعادة تجميع القطع المشكولة في مواقعها الأصلية بدقة.

---

## Slice 2.2: المحرك الهجين الآمن للخيوط وبث SSE (Thread-Safe ONNX + Libtashkeel + SSE)
**الهدف:** تشغيل الاستنتاج العصبي بأمان في الخلفية وبث النتائج لحظياً عبر `Server-Sent Events`.

### المهام (Tasks):
- [x] **Task 2.2.1:** تطبيق **وضع المحاكاة القياسي (`MIZAJ_ENGINE_MODE=mock`)** في `backend/app/engine/mock_engine.py` كما هو موثق في `AGENTS.md` ليعمل تلقائياً في بيئات الاختبار السحابية (CI / Google Jules) أو عند عدم وجود ملف الـ ONNX.
- [x] **Task 2.2.2:** _(ملاحظة: `libtashkeel` غير منشور على PyPI؛ الوضع السريع يستخدم `mishkal` حالياً مع adapter يُفعَّل تلقائياً إذا توفرت الحزمة)_ دمج حزمة `libtashkeel` (Rust Bindings) كمحرك للوضع السريع (`fast` mode) للتشكيل الفوري.
- [x] **Task 2.2.3:** _(ملاحظة: رابط v1.0.0 INT8 غير موجود (404)؛ نستخدم الإصدار الرسمي `v2/eo_model_onnx.zip` (float، ~78MB) مع تحقق SHA256)_ دمج نموذج `CATT (Encoder-Only INT8 Quantized ONNX)` (المسحوب عبر `scripts/download_models.py` بحجم ~42MB) مع ضبط إعدادات الخيوط الإلزامية لمنع التزاحم في `onnxruntime.SessionOptions`:
  * `sess_options.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)`
  * `sess_options.inter_op_num_threads = 1`
  * `sess_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL`
  وتشغيله داخل `ThreadPoolExecutor(max_workers=2)` حتى لا يحجب حلقة `asyncio` الخاصة بـ FastAPI.
- [x] **Task 2.2.4:** بناء مسار البث الحي **`POST /api/tashkeel/stream` باستخدام `Server-Sent Events (SSE)`** (أخف وأكثر استقراراً من WebSockets على HTTP/1.1 ولا يحتاج لـ Handshake معقد)، مع دعم استئناف التشكيل تلقائياً من الكاش في حال انقطاع الاتصال.

---

## Slice 2.3: التدقيق الصرفي عبر Mishkal وكاش SQLite (Morphological Fusion & Cache)
**الهدف:** فلترة مخرجات الشبكة العصبية صرفياً وتوفير اقتراحات إعرابية وصرفية لكل كلمة.

### المهام (Tasks):
- [x] **Task 2.3.1:** ربط الفاحص الصرفي من حزمة `mishkal` (`tashkeel.TashkeelClass` والمحلل الصرفي `qalsadi`) لمراجعة الكلمات الناتجة وتصحيح أي تشكيل يخالف الأوزان الصرفية العربية.
- [x] **Task 2.3.2:** بناء مسار `GET /api/word-suggestions?word=...` لإرجاع كافة التشكيلات الصرفية والإعرابية المحتملة للكلمة مع وصفها النحوي.
- [x] **Task 2.3.3:** ربط جدول `tashkeel_cache`: فحص الكلمات والجمل قبل إرسالها للنموذج، وزيادة عداد `usage_count` عند كل استخدام، وإعطاء الأولوية القصوى للكلمات التي تحمل `is_user_locked = 1`.
