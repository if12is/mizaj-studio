# مشروع: مِزَاج (Mizaj Studio) - استوديو التشكيل العربي الذكي (مفتوح المصدر)
**النسخة:** 2.0.0 (Offline Desktop Edition - Reviewed & Hardened)
**الترخيص القانوني:** **GNU General Public License v3.0 (GPL-3.0-or-later)**
**المعمارية:** Local-First Desktop App (Electron + Vue 3 + CodeMirror 6 + Tailwind CSS + Python FastAPI Sidecar + SQLite WAL)

---

## 1. حسم ملف التراخيص القانونية (Licensing Resolution - GPL-3.0)
لتفادي أي تعارض قانوني مع المكتبات العربية المفتوحة المصدر، تم اعتماد رخصة **GPL-3.0** للمشروع بالكامل:

| المكتبة / النموذج | الاسم الدقيق للحزمة (PyPI / Repo) | الترخيص | حالة التوافق في مشروعنا (GPL-3.0) |
| :--- | :--- | :--- | :--- |
| **Mishkal** (شاملاً محرك الصرف `qalsadi`) | `mishkal==0.4.1` | GPL-3.0 | متوافق 100% (لتشابه رخصة المشروع GPL-3.0) |
| **PyArabic** | `pyarabic==0.6.15` | GPL-3.0 | متوافق 100% |
| **Libtashkeel** (Rust Core + Python Bindings) | `libtashkeel` | MIT | متوافق 100% مع GPL-3.0 |
| **CATT Model & Weights** | `abjadai/catt` | Apache-2.0 | متوافق 100% مع GPL-3.0 (Apache 2.0 -> GPLv3) |
| **ONNX Runtime (CPU)** | `onnxruntime==1.17.1` | MIT | متوافق 100% |
| **Python-DOCX + LXML** | `python-docx==1.1.0`, `lxml==5.1.0` | MIT / BSD | متوافق 100% |

---

## 2. الهوية البصرية وتصميم اللوجو (Brand Identity)
* **الاسم:** **مِزَاج (Mizaj Studio)**
* **تصور اللوجو:** دمج هندسي بسيط (Minimalist Flat Vector) بين **"سن قلم الحبر الكلاسيكي"** متجهاً للأعلى، وتعلوه **"حركة الشدّة والفتحة (ـّـَ)"** كأنها تاج مضيء.
* **الخطوط المدمجة أوفلاين (Typography):**
  * **واجهة المستخدم (UI):** خط **Cairo (القاهرة)** بوزن Bold/SemiBold بدون أي نصوص إضافية مزدحمة.
  * **محرر النصوص وتلوين الحركات:** خط **`Amiri-Mizaj-Colr.woff2`** (نسخة معدلة بتقنية **OpenType `COLR/CPAL`** تتيح تلوين الحركات بصرياً عبر CSS `font-palette` دون فصل الحروف أو كسر النسخ أو التحديد).
* **لوحة الألوان:**
  * **الأزرق الليلي (`#0F172A` - Slate 900):** خلفية الوضع الليلي.
  * **الأخضر الزمردي (`#10B981` - Emerald 500):** اللون الأساسي ولون الحركات في الوضع الملون.
  * **الذهبي الكهرماني (`#F59E0B` - Amber 500):** للون حركة الشدة وتمييز الكلمات ذات الأوجه الإعرابية المتعددة.

---

## 3. خارطة مراحل التنفيذ (Phases & Vertical Slices)
1. `01_Phase1_Foundation_And_Architecture.md`: البنية التحتية، CodeMirror 6 Virtual PoC، خط COLR/CPAL، محرك Python Sidecar الآمن، قاعدة بيانات SQLite الكاملة مع نظام Migrations، وشاشة الإعدادات.
2. `02_Phase2_Hybrid_Tashkeel_Engine.md`: محرك التشكيل الهجين (`libtashkeel` + `CATT ONNX INT8` Thread-safe + `mishkal`) مع بث `SSE` ونظام `Mock Mode` القياسي.
3. `03_Phase3_Docx_Preservation_Engine.md`: محرك `.docx` المتقدم (دمج الـ Runs المتطابقة، الجداول، الترويسات، الحواشي السفلية والعلوية عبر `lxml`، مربعات النصوص، ومعالجة النصوص المختلطة عربي/إنجليزي).
4. `04_Phase4_Large_Scale_Interactive_UI.md`: محرر CodeMirror 6 للمقالات الضخمة (100+ صفحة بسرعة 60 FPS)، Undo/Redo، اختصارات لوحة المفاتيح، والنافذة المنبثقة لتعديل الحركات دون كسر المؤشر.
5. `05_Phase5_Offline_Packaging_And_Release.md`: التجميع الأوفلاين عبر PyInstaller (مع توثيق `hiddenimports` والحجم الواقعي 250-350MB)، اختبارات Playwright E2E، وآلية التحديث الأوفلاين/الهجين.
