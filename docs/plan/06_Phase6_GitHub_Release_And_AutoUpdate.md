# Phase 6: إصدار نسخة Windows (.exe) عبر GitHub Actions والتحديث التلقائي من GitHub Releases

**الهدف:** بناء ملف التثبيت `.exe` تلقائياً عبر GitHub Actions ورفعه كـ **GitHub Release** (بدون أي سيرفرات خارجية)، مع مُحدِّث داخل البرنامج يتحقق من GitHub Releases عند وجود إصدار جديد.

> **المرجع:** نفس أسلوب الـ workflow المستخدم في مشروع Laravel `MaT3am` (بناء الـ exe والنشر). يجب قراءة ذلك الـ workflow ومحاكاة بنيته قبل التنفيذ.

> **ملاحظة خصوصية:** سياسة "Zero Network Egress" في `AGENTS.md` تُعدَّل هنا باستثناء وحيد وصريح: فحص التحديثات من `api.github.com` / `github.com` لمستودع المشروع فقط، مع إمكانية تعطيله من الإعدادات.

### ملخص نمط `if12is/MaT3am` (`.github/workflows/electron-release.yml` + `electron/updater.cjs`)
- **Trigger:** `workflow_dispatch` بمدخلات (`version`, `publish: boolean`, `runner: github-hosted | self-hosted`) — والـ tag `v*` في workflow منفصل. `concurrency` لكل ref مع `cancel-in-progress`، و `timeout-minutes: 90`، و `runs-on: windows-latest` أو `[self-hosted, Windows]`.
- **الخطوات:** Checkout ← تحديد publish mode (pwsh) ← `scripts/electron-sync-version.cjs` (يأخذ الإصدار من `RELEASE_VERSION` أو `GITHUB_REF_NAME` ويكتبه في `package.json`) ← preflight يتحقق من الأسرار (`GH_TOKEN`) ← تثبيت الاعتماديات ← `electron-builder --win --publish always|never` ← `actions/upload-artifact@v4` (`*.exe` + `latest.yml`) ← **تحقق بعد النشر** عبر `gh release view` من وجود `Setup <version>.exe` و `latest.yml`.
- **electron-builder:** NSIS (`oneClick: false`, `allowToChangeInstallationDirectory`, `differentialPackage: true`, `installer.nsh`)، `electronLanguages: [en-US, ar]`.
- **المُحدِّث:** `electron-updater` مع `autoDownload`, `autoInstallOnAppQuit: false`, `allowDowngrade: false`, `disableWebInstaller`, logger = electron-log، جدولة فحص دورية + فحص يدوي، وأحداث `update-available / not-available / download-progress / update-downloaded / error` تُرسل للواجهة، و `quitAndInstall(false, true)`.
- **الفرق عندنا:** المزوّد `github` مباشرة على `if12is/mizaj-studio` (Releases في نفس المستودع) بدلاً من `generic` + سيرفر `update.servexapp.com` أو مستودع releases منفصل؛ ولا نحتاج PHP/تشفير `.env`. نضيف بدلاً منها: Python 3.11.7 + PyInstaller للـ sidecar + تنزيل نموذج CATT والتحقق من SHA256.

---

## Slice 6.1: Workflow البناء والإصدار (Build & Release Workflow)
### المهام (Tasks):
- [x] **Task 6.1.1:** قراءة workflow مشروع `MaT3am` وتوثيق خطواته (المُشغِّل، الأسرار، طريقة التوقيع، التسمية، trigger).
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
