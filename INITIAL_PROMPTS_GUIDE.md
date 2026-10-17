# دليل البرومبتات الجاهزة للوكلاء — النسخة المحدّثة والمحكّمة (v2.0)

تم تدقيق جميع المسارات وإزالة أي مسافات زائدة، وتحديث المهام لتشمل كافة التحسينات المعمارية (CodeMirror 6، خط COLR/CPAL، قاعدة البيانات الكاملة مع Migrations، شاشة الإعدادات، ووضع المحاكاة القياسي `MIZAJ_ENGINE_MODE=mock`).

---

## Prompt 1: ضربة البداية وتنفيذ المرحلة الأولى كاملة (Phase 1 Kickoff Prompt)
انسخ هذا البرومبت وضعه مباشرة في **Google Jules** (أو Cursor / Claude Code):

```text
Read `AGENTS.md`, `docs/architecture/data-flow.md`, `docs/architecture/threading-model.md`, `docs/architecture/error-codes.md`, `docs/plan/00_README_And_Brand_Identity.md`, and `docs/plan/01_Phase1_Foundation_And_Architecture.md` carefully.

Your task is to execute **Phase 1 (Foundation, Editor PoC, Sidecar Crash Recovery, Full SQLite Schema & Settings — Slices 1.1, 1.2, 1.3, and 1.4)** from scratch following all rules in `AGENTS.md`:

1. **Slice 1.1 (Electron + Vue 3 + CodeMirror 6 Virtual Editor & COLR Font PoC in `desktop/`):**
   - Initialize an `electron-vite` + Vue 3 (Composition API, TypeScript) + Pinia + Tailwind CSS project inside `desktop/` enforcing `"engines": { "node": ">=20.11.0" }` and ESLint/Prettier.
   - Configure RTL (`dir="rtl" lang="ar"`), dark/light theme using the Mizaj palette (`#0F172A` Slate, `#10B981` Emerald, `#F59E0B` Amber), `Cairo` font for UI, and `Amiri` with CSS `font-palette` support (`--mizaj-colored`) for zero-DOM-breakage colored diacritics.
   - Integrate **CodeMirror 6** (`@codemirror/view`, `@codemirror/state`, `@codemirror/commands`) as the core RTL virtualized document editor capable of loading and scrolling `backend/tests/fixtures/sample_long.txt` (35,000+ words) at 60 FPS.
   - Build the frameless RTL Titlebar, Project/Folder Sidebar, main editor workspace, Settings modal, and bottom Status Bar.

2. **Slice 1.2 (Resilient Python FastAPI Sidecar & Unified Logging in `backend/`):**
   - Create `backend/requirements.txt` with exact `==` pinned versions (`fastapi==0.110.0`, `uvicorn==0.28.0`, `pydantic==2.6.4`, `pyarabic==0.6.15`, `mishkal==0.4.1`, `onnxruntime==1.17.1`, `python-docx==1.1.0`, `lxml==5.1.0`, `pytest==8.1.1`, `ruff==0.3.2`).
   - Implement `backend/app/main.py` binding strictly to `127.0.0.1` with `--port 0`, printing `MIZAJ_PORT=<assigned_port>` and `MIZAJ_STATUS=READY` to `stdout` (flushed), and exposing `GET /health`.
   - Implement `PythonProcessManager` in `desktop/src/main/pythonManager.ts` using `spawn(..., { windowsHide: true })`, parsing `MIZAJ_PORT`, implementing automatic crash recovery with exponential backoff (1s, 2s, 4s, max 3 retries), and terminating cleanly on `will-quit`.
   - Configure unified rotating file logs (`5MB` max, 5 backups) in `<userData>/logs/` for both Electron and Python.

3. **Slice 1.3 (Full SQLite WAL Database & Migration Runner):**
   - Implement `backend/app/core/database.py` with `PRAGMA journal_mode=WAL;`, `PRAGMA synchronous=NORMAL;`, `PRAGMA foreign_keys=ON;`, and `PRAGMA busy_timeout=5000;`.
   - Build a `PRAGMA user_version` migration runner in `backend/app/core/migrations.py` that backs up the `.db` file before applying migrations.
   - Create all 5 tables in migration `001_initial.sql`:
     * `projects` (`id`, `name`, `description`, `created_at`, `updated_at`)
     * `documents` (`id`, `project_id`, `title`, `raw_content`, `diacritized_content`, `source_docx_path`, `language`, `direction`, `word_count`, `is_deleted`, `created_at`, `updated_at`)
     * `tashkeel_cache` (`id`, `word_or_phrase` UNIQUE via `idx_cache_word_unique`, `diacritized_form`, `source`, `is_user_locked`, `usage_count`, `created_at`, `updated_at`)
     * `settings` (`key` PRIMARY KEY, `value`, `updated_at`)
     * `recent_files` (`id`, `file_path` UNIQUE, `document_id`, `last_opened_at`)
   - Connect a smart debounced auto-save (5 seconds idle + immediate flush on window blur/close/document switch).

4. **Slice 1.4 (Settings & Personal Dictionary API + UI):**
   - Expose CRUD endpoints for `/api/projects`, `/api/documents`, `/api/settings`, and `/api/dictionary` (managing user-locked words in `tashkeel_cache`).
   - Build the Settings & Personal Dictionary UI modal in Vue 3.

5. **Testing & Verification:**
   - Write comprehensive `pytest` tests in `backend/tests/test_phase1.py` covering `/health`, SQLite WAL mode, migrations, projects/documents CRUD, settings, and dictionary uniqueness constraints.
   - Ensure `cd backend && pytest` and `cd desktop && npm run typecheck && npm run build` pass 100%.
   - Mark completed tasks as `[x]` in `docs/plan/01_Phase1_Foundation_And_Architecture.md`.
```

---

## Prompt 2: تنفيذ المرحلة الثانية - محرك التشكيل الهجين وبث SSE (Phase 2 Prompt)

```text
Read `AGENTS.md`, `docs/architecture/threading-model.md`, and `docs/plan/02_Phase2_Hybrid_Tashkeel_Engine.md`.
Execute **Phase 2 (Hybrid Tashkeel Core Engine — Slices 2.1, 2.2, and 2.3)**:
1. Implement `ArabicSentenceSplitter` (`<= 256` chars per chunk to fit CATT's 512-char context window) and `PartialDiacritizationLock` using `pyarabic` in `backend/app/engine/chunker.py` with a reversible `ChunkMap`.
2. Implement the deterministic `MockEngine` (`MIZAJ_ENGINE_MODE=mock`) as specified in `AGENTS.md` Section 3, alongside the real `libtashkeel` (`fast` mode) and `CATT ONNX INT8` (`accurate` mode) runners dispatched via `ThreadPoolExecutor(max_workers=2)` with thread-safe `onnxruntime.SessionOptions`.
3. Integrate `mishkal` morphological post-validation and `GET /api/word-suggestions?word=...`.
4. Implement `POST /api/tashkeel/stream` using **Server-Sent Events (SSE)** with SQLite `tashkeel_cache` lookup/persistence so interrupted streams can resume instantaneously.
5. Add unit and integration tests in `backend/tests/test_phase2_engine.py` (testing chunking, partial lock preservation, SSE streaming, cache hits, and word suggestions under `MIZAJ_ENGINE_MODE=mock`) and mark tasks `[x]` in `docs/plan/02_Phase2_Hybrid_Tashkeel_Engine.md`.
```

---

## Prompt 3: تنفيذ المرحلة الثالثة - محرك الوورد المتقدم (Phase 3 Prompt)

```text
Read `AGENTS.md`, `docs/architecture/error-codes.md`, and `docs/plan/03_Phase3_Docx_Preservation_Engine.md`.
Execute **Phase 3 (DOCX Preservation Engine — Slices 3.1 and 3.2)**:
1. Build the non-destructive `.docx` processor in `backend/app/docx_processor/` that merges adjacent runs ONLY when their 7-tuple `RunStyleSignature` `(bold, italic, underline, color_rgb, font_name, font_size, rtl)` is identical.
2. Support paragraphs, nested tables, headers/footers, and XML-level footnotes (`w:footnotes`), endnotes (`w:endnotes`), textboxes (`w:txbxContent`), and content controls (`w:sdtContent`) via `lxml`.
3. Implement intra-run mixed Arabic/English/Code tokenization so Arabic words inside mixed runs (e.g., `"اشتريت جهاز iPhone 16 Pro الجديد"`) are diacritized while English words, numbers, URLs, and monospace code runs remain untouched.
4. Implement the 3 diacritization modes (`full`, `irab_only`, `minimal`) and atomic file saving with `ERR_DOCX_WRITE_LOCKED` (`423`) handling.
5. Write `pytest` tests in `backend/tests/test_phase3_docx.py` against `backend/tests/fixtures/sample_ar.docx` and `backend/tests/fixtures/sample_mixed.docx`, and update checkboxes in `docs/plan/03_Phase3_Docx_Preservation_Engine.md`.
```

---

## Prompt 4: تنفيذ المرحلة الرابعة - واجهة المحرر المتقدمة (Phase 4 Prompt)

```text
Read `AGENTS.md` and `docs/plan/04_Phase4_Large_Scale_Interactive_UI.md`.
Execute **Phase 4 (Large-Scale Interactive Editor UI — Slices 4.1, 4.2, and 4.3)** in `desktop/`:
1. Complete the CodeMirror 6 editor extensions: full Undo/Redo transaction history, `.docx` Drag & Drop zone with pre-processing preview, and SSE live progress overlay with Pause/Resume/Cancel.
2. Implement the Colored Diacritics `font-palette` toggle and the `Word Inspector Popover` using CodeMirror 6 atomic transactions (`view.dispatch({ changes: { from, to, insert } })`) so selecting a Mishkal suggestion or clicking the mini diacritic keypad modifies the word without breaking cursor position.
3. Add "Apply to All Occurrences", "Save to Personal Dictionary", keyboard shortcuts (`Ctrl+Shift+T`, `Ctrl+Shift+R`, `Ctrl+Shift+C`, `Ctrl+Space`), Side-by-Side Synced Diff View (`@codemirror/merge`), and the live document analytics panel.
4. Write Vitest component tests in `desktop/tests/` and mark tasks `[x]` in `docs/plan/04_Phase4_Large_Scale_Interactive_UI.md`.
```

---

## Prompt 5: تنفيذ المرحلة الخامسة - التجميع واختبارات Playwright E2E (Phase 5 Prompt)

```text
Read `AGENTS.md` and `docs/plan/05_Phase5_Offline_Packaging_And_Release.md`.
Execute **Phase 5 (Offline Packaging, Playwright E2E & Release — Slices 5.1 and 5.2)**:
1. Create `backend/mizaj_engine.spec` and `scripts/build_backend.py` with all explicit `hiddenimports` and `datas` for `onnxruntime`, `mishkal`, `qalsadi`, `arramooz`, `pyarabic`, `libtashkeel`, and `python-docx`.
2. Configure `desktop/electron-builder.yml` for Windows NSIS (`.exe`) and macOS (`.dmg`), and implement the manual opt-in update checker + offline `.mizajpack` model importer in Settings.
3. Create Playwright for Electron E2E tests in `desktop/tests/e2e/app.spec.ts` covering app launch, DOCX import (`sample_ar.docx`), diacritization, word popover edit, and DOCX export, plus a 35,000-word (`sample_long.txt`) memory/performance benchmark (`< 500MB` RAM).
4. Mark all tasks `[x]` in `docs/plan/05_Phase5_Offline_Packaging_And_Release.md`.
```
