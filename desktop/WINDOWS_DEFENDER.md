# Windows Defender / SmartScreen — مِزَاج

القسم العربي أولاً، ثم English.

---

## العربية

### لماذا قد يعتبر Defender التثبيت مشبوهًا؟

- المثبّت **غير موقّع** (قرار المالك)، فلا سمعة لناشر معروف، وتظهر SmartScreen رسالة «Windows protected your PC».
- المحرك مُجمَّد بـ PyInstaller: ملف تنفيذي صغير (bootloader) يفكّ ويشغّل بايثون، وهذا النمط تشاركه برمجيات خبيثة كثيرة، كما أن الـ bootloader الجاهز المنشور على PyPI معروف البصمة لدى شركات مكافحة الفيروسات.
- ملف جديد بلا سمعة (لم يره ملايين المستخدمين بعد) يُفحص بقواعد سلوكية/سحابية أكثر حدّة.
- ملفات تنفيذية بلا معلومات إصدار (Company/Description) تبدو أكثر ريبة.

### ما الذي نفعله في المشروع

1. لا UPX إطلاقًا (`upx=False`)، بناء onedir لا onefile، ولا `runtime_tmpdir` (لا فك ضغط إلى مجلد مؤقت عند كل تشغيل).
2. مورد VERSIONINFO في `mizaj-engine.exe`: الشركة «Mizaj Studio»، الوصف «Mizaj Studio engine»، حقوق النشر `GPL-3.0-or-later`، الإصدار من `MIZAJ_VERSION` أو `desktop/package.json`.
3. إعادة بناء bootloader الخاص بـ PyInstaller من المصدر على المُشغّل (`python scripts/build_backend.py --rebuild-bootloader`)، فلا تتطابق بصمته مع النسخة الجاهزة التي تُوسَم بكثرة.
4. المثبّت `asInvoker` وللمستخدم الحالي فقط (لا صلاحيات مسؤول).
5. سير عمل `defender-scan.yml` (يدوي) يبني ويفحص المثبّت والمحرك والملفات المثبّتة بـ Defender ويُصدر ملخصًا في الـ annotations، ويمكنه فحص آخر إصدار منشور.
6. اختياريًا: صفحة في المثبّت (غير مفعّلة افتراضيًا) لاستثناء **مجلد التثبيت فقط** (انظر الأسفل).

### إرسال حالة «إيجابي كاذب» إلى Microsoft

1. افتح https://www.microsoft.com/en-us/wdsi/filesubmission وسجّل الدخول بحساب Microsoft.
2. اختر **Software developer** (وليس «Home customer»).
3. اختر «Submit a file» وحدّد الملفات: **`Mizaj-Studio-Setup-<version>.exe`** و**`mizaj-engine.exe`** (من `resources\engine\` أو من `backend/dist/mizaj-engine`). افعل ذلك **لكل إصدار**، لأن الحكم مرتبط بتجزئة الملف.
4. اختر «The file is incorrectly detected as malware/malicious» (أو ما يناسب)، واذكر اسم الكشف الظاهر (مثل `Trojan:Win32/...!ml`)، وأرفق رابط المستودع (GPL) والإصدار.
5. تابع الحالة في «Submission history» بنفس الحساب.

الجدول الزمني: لا توجد مدة رسمية مضمونة. من تقارير المطورين، يتراوح الرد غالبًا من ساعات إلى بضعة أيام، وأحيانًا أطول. عند الاعتراض على القرار النهائي استخدم نموذج «developer contact» في نتيجة الإرسال. بعد القبول تصدر تواقيع جديدة (تظهر خلال ساعات) وقد تحتاج لتحديث تواقيع الأجهزة. أرسل **قبل** نشر الإصدار للجمهور إن أمكن (انشره كـ pre-release/draft وأرسل ملفاته).

### SmartScreen والسمعة

- SmartScreen يعتمد على **سمعة الملف/الناشر**. بدون توقيع تُبنى السمعة لكل تجزئة ملف على حدة، ولذلك يتكرر التحذير مع كل إصدار جديد حتى يُنزَّله ويشغّله عدد كافٍ من المستخدمين.
- المستخدم يستطيع المتابعة: «More info» ثم «Run anyway».
- شهادات OV تبني السمعة تدريجيًا؛ أما EV فلم تعد تمنح تجاوزًا فوريًا لـ SmartScreen كما كان يُقال قديمًا (سلوك Microsoft تغيّر)، فلا تدفع فرق سعر EV لهذا السبب وحده.

### التوقيع (خيار مستقبلي — المالك يرفضه حاليًا)

- **Azure Artifact Signing** (كان اسمه Trusted Signing): الأرخص عمليًا، الفئة Basic حوالي **9.99 دولار/شهر** (حتى 5000 توقيع شهريًا) حسب ملخص بحث حديث؛ **تحقّق من الصفحة الرسمية قبل الاعتماد** لأن صفحة الأسعار لم أستطع قراءتها مباشرة.
- الأهلية (حسب المصادر الثانوية، وقد تتوسع): المؤسسات في الولايات المتحدة وكندا والاتحاد الأوروبي وبريطانيا، والأفراد في الولايات المتحدة وكندا فقط. المطوّر خارج هذه الدول قد لا يكون مؤهلًا.
- بدائل: شهادة **OV** من جهة معتمدة (تقريبًا 100–400 دولار/سنة، والمفتاح يجب أن يكون على عتاد/خدمة سحابية وفق قواعد CA/B Forum)، أو **EV** (أغلى، 250–600 دولار/سنة تقريبًا، وتحقق أشد). الأسعار تقريبية وتتغير.
- برنامج SignPath Foundation يوفر توقيعًا مجانيًا لمشاريع المصدر المفتوح المؤهلة (GPL مناسب) — يستحق التحقق من شروطه.
- عند التوقيع: أضف `publisherName` في `win:` ضمن `electron-builder.yml` (لا فائدة منه بدون توقيع).

### استثناء مجلد التثبيت (اختياري، معطّل افتراضيًا)

صفحة في المثبّت بخانة **غير محددة افتراضيًا**: «استثناء مجلد مِزَاج من فحص Windows Defender (يتطلب صلاحية المسؤول)». عند تحديدها فقط، يُشغَّل PowerShell بصلاحية مرتفعة (UAC) وينفّذ `Add-MpPreference -ExclusionPath "<مجلد التثبيت>"`، ويُخزَّن علم في `HKCU\Software\<AppId>\DefenderExclusion`. المُلغي للتثبيت يزيل الاستثناء (`Remove-MpPreference`) فقط إن كان العلم موجودًا. لا يعمل أثناء التثبيت الصامت (`/S`) ولا التحديثات (`--updated`): تبقى الحالة كما هي.

**المخاطر بصراحة:**

- يخفّض الحماية لذلك المجلد: أي ملف خبيث يُسقَط فيه لن يُفحص.
- بعض سلوكيات Defender الاستدلالية قد تعتبر مثبّتًا يضيف استثناءات سلوكًا مشبوهًا بحد ذاته.
- سياسات الشركات/المؤسسات (GPO/Intune/Tamper Protection) قد تمنع الأمر؛ يفشل بصمت ولا نتحقق من نجاحه (لا يمكن قراءة قائمة الاستثناءات دون صلاحية مسؤول).
- الاستثناء لا يمنع تحذير SmartScreen للمثبّت نفسه ولا فحص المثبّت قبل التثبيت.
- المسار يحتوي على علامة اقتباس مفردة `'` قد يفشل (نادر في `%LOCALAPPDATA%`).
- ملف `installer.nsh` لم يُجرَّب هنا محليًا (لا makensis)؛ يُختبر ببناء `defender-scan.yml`.

---

## English

### Why Defender may flag it

- The installer is **unsigned** (owner decision): no publisher reputation, SmartScreen shows "Windows protected your PC".
- The engine is frozen with PyInstaller. Its small bootloader unpacks and runs Python, a pattern shared by lots of malware, and the prebuilt bootloader from PyPI is widely fingerprinted by AV vendors.
- Brand-new files with no prevalence get stricter cloud/behavioural scrutiny.
- Executables lacking VERSIONINFO (company/description) look more suspicious.

### What we do

1. No UPX (`upx=False`), onedir (not onefile), no `runtime_tmpdir`.
2. VERSIONINFO on `mizaj-engine.exe`: CompanyName "Mizaj Studio", FileDescription "Mizaj Studio engine", LegalCopyright `GPL-3.0-or-later`, version from `MIZAJ_VERSION` or `desktop/package.json`.
3. Bootloader compiled from source in CI: `python scripts/build_backend.py --rebuild-bootloader` (equivalent to `PYINSTALLER_COMPILE_BOOTLOADER=1 pip install --force-reinstall --no-binary pyinstaller --no-cache-dir pyinstaller==6.5.0`; needs MSVC, present on `windows-latest`).
4. `asInvoker` per-user installer (no admin rights).
5. `.github/workflows/defender-scan.yml` (manual): builds like the release, updates signatures, scans installer / engine / win-unpacked / silently installed dir with `MpCmdRun.exe -Scan -ScanType 3 -DisableRemediation`, reports `Get-MpThreatDetection`, and always ends with a summary annotation ("no detections" or threat names and paths). Optionally scans the latest published release installer.
6. Optional opt-in exclusion page for the install folder only (below).

### Submitting a false positive to Microsoft

1. Go to https://www.microsoft.com/en-us/wdsi/filesubmission and sign in.
2. Choose **Software developer**.
3. Submit `Mizaj-Studio-Setup-<version>.exe` and `mizaj-engine.exe` for **each release** (verdicts are per file hash). Ideally submit before announcing the release (publish as pre-release first).
4. Select that the file is incorrectly detected, include the detection name shown (e.g. `Trojan:Win32/...!ml`), the repo URL (GPL source) and version.
5. Track status in Submission history with the same account.

Timeline: Microsoft publishes no guaranteed SLA. Developers report anything from hours to several days, occasionally longer, and some report stale "In progress" statuses. If you disagree with a final verdict, use the developer contact form linked in the result. Accepted submissions result in updated signatures, which clients must download.

### SmartScreen reputation

- Reputation is per file hash (unsigned) or per certificate/publisher (signed). Unsigned: every new release restarts the warm-up until enough users run it. Users can click "More info" then "Run anyway".
- OV certificates build reputation over time. EV no longer gives an instant SmartScreen pass the way it once did, so do not pay for EV solely for that.

### Cheapest signing paths (future; owner currently declines)

- **Azure Artifact Signing** (formerly Trusted Signing): about **USD 9.99/month** for the Basic tier (about 5,000 signatures/month), per a recent search summary. I could not open Microsoft's pricing page from this environment, so verify before relying on it.
- Eligibility per secondary sources (may expand): organizations in the USA, Canada, EU and UK; individuals only in the USA and Canada. Developers elsewhere may be ineligible.
- **OV** certificate from a commercial CA: roughly USD 100-400/year, private key on hardware token or cloud HSM (CA/B Forum rules). **EV**: roughly USD 250-600/year, stricter vetting. Prices are approximate.
- Free option worth checking: SignPath Foundation signing for eligible open-source projects (GPL qualifies in principle).
- When signing: set `win.publisherName` in `electron-builder.yml` (meaningless without signing).

### Optional Defender exclusion (OFF by default)

An installer page with an **unchecked** box: "Exclude the Mizaj folder from Windows Defender scanning (requires administrator)". Only if checked, an elevated (UAC) PowerShell runs `Add-MpPreference -ExclusionPath "<install dir>"` (that folder only, never processes, extensions or drives) and a flag is stored at `HKCU\Software\<AppId>\DefenderExclusion`. The uninstaller runs `Remove-MpPreference -ExclusionPath` (elevated) only if that flag exists. Silent installs (`/S`) and updates (`--updated`) never add or remove it; existing state is kept. The flag lives outside the uninstall key because electron-builder deletes that key before `customUnInstall` runs.

**Honest risks:**

- It lowers protection for that folder: malware dropped there is not scanned.
- Behavioural heuristics may treat an installer that adds exclusions as suspicious in itself.
- Corporate policy (GPO/Intune/Tamper Protection) may block it; the command then fails and we cannot verify success, since reading the exclusion list requires admin.
- It does not remove the SmartScreen prompt or the scan of the installer before it runs.
- A single quote `'` in the install path would break the command (rare under `%LOCALAPPDATA%`).
- `installer.nsh` could not be compiled locally (no makensis); the `defender-scan.yml` build is its test.
