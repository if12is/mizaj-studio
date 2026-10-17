# Phase 6: إصدار نسخة Windows (.exe) عبر GitHub Actions والتحديث التلقائي من GitHub Releases

**الهدف:** بناء ملف التثبيت `.exe` تلقائياً عبر GitHub Actions ورفعه كـ **GitHub Release** (بدون أي سيرفرات خارجية)، مع مُحدِّث داخل البرنامج يتحقق من GitHub Releases عند وجود إصدار جديد.

> **المرجع:** نفس أسلوب الـ workflow المستخدم في مشروع Laravel `MaT3am` (بناء الـ exe والنشر). يجب قراءة ذلك الـ workflow ومحاكاة بنيته قبل التنفيذ.

> **ملاحظة خصوصية:** سياسة "Zero Network Egress" في `AGENTS.md` تُعدَّل هنا باستثناء وحيد وصريح: فحص التحديثات من `api.github.com` / `github.com` لمستودع المشروع فقط، مع إمكانية تعطيله من الإعدادات.

---

## Slice 6.1: Workflow البناء والإصدار (Build & Release Workflow)
### المهام (Tasks):
- [ ] **Task 6.1.1:** قراءة workflow مشروع `MaT3am` وتوثيق خطواته (المُشغِّل، الأسرار، طريقة التوقيع، التسمية، trigger).
- [ ] **Task 6.1.2:** إنشاء `.github/workflows/release.yml` يعمل على `windows-latest` عند دفع tag بصيغة `v*.*.*` (و `workflow_dispatch`):
  1. إعداد Python `3.11.7` و Node `20.11.0`.
  2. تشغيل `pytest` (mock) و `npm run typecheck` كبوابة جودة قبل البناء.
  3. تجميع الـ backend عبر **PyInstaller** إلى `mizaj-backend.exe` (مع `hiddenimports` لـ `mishkal`/`qalsadi`/`onnxruntime`).
  4. تنزيل نموذج CATT عبر `scripts/download_models.py` مع التحقق من SHA256 وتضمينه كـ `extraResources`.
  5. بناء المثبّت عبر **electron-builder** (NSIS) لإنتاج `Mizaj-Studio-Setup-<version>.exe` + `latest.yml` + `.blockmap`.
  6. نشر الملفات كـ **GitHub Release** باستخدام `GITHUB_TOKEN` (`electron-builder --publish always` بمزوّد `github`).
- [ ] **Task 6.1.3:** مزامنة رقم الإصدار بين `desktop/package.json` والـ tag، وتوليد Release Notes تلقائياً من الـ commits.
- [ ] **Task 6.1.4 (اختياري):** توقيع الكود (Code Signing) إن توفرت شهادة في الأسرار؛ وإلا يُوثَّق تحذير SmartScreen.

---

## Slice 6.2: المُحدِّث داخل البرنامج (In-App Auto-Updater from GitHub Releases)
### المهام (Tasks):
- [ ] **Task 6.2.1:** دمج `electron-updater` بمزوّد `github` (`owner: if12is`, `repo: mizaj-studio`) في `desktop/src/main/updater.ts`.
- [ ] **Task 6.2.2:** فحص التحديثات عند بدء التشغيل (بعد 10 ثوانٍ) وكل 6 ساعات، مع زر "التحقق من التحديثات" في الإعدادات وخيار تعطيل الفحص التلقائي (`settings.auto_update_check`).
- [ ] **Task 6.2.3:** واجهة RTL: إشعار "يتوفر إصدار جديد"، شريط تقدّم التنزيل، وزر "إعادة التشغيل والتثبيت"، مع إرسال أحداث IPC (`updater:status`).
- [ ] **Task 6.2.4:** ضمان إيقاف الـ Python sidecar بأمان وتفريغ الحفظ التلقائي قبل `quitAndInstall()`.
- [ ] **Task 6.2.5:** اختبارات وحدة للمُحدِّث (mock لـ `autoUpdater`) واختبار تكامل يدوي: إصدار `v0.1.0` ثم `v0.1.1` والتحقق من ظهور التحديث وتثبيته.
