# AGENTS.md — Master Engineering & AI Agent Specification for Mizaj Studio

Welcome Agent! This is the single source of truth for architectural rules, error handling, mock modes, and verification workflows.

---

## 1. Licensing & Open-Source Compliance
- **License:** The entire project is strictly **GPL-3.0-or-later** (see `LICENSE`).
- This resolves all licensing constraints with `mishkal` (GPL-3.0) and `pyarabic` (GPL-3.0), allowing full bundling and distribution alongside `libtashkeel` (MIT), `onnxruntime` (MIT), `python-docx` (MIT), and `abjadai/catt` (Apache-2.0).

---

## 2. Exact Package Names & Pinned Versions
- **Python (`3.11.7`):**
  - Use `libtashkeel` (NOT `pylibtashkeel` — verify PyPI package name `libtashkeel` which provides Python bindings to the Rust library).
  - Use `mishkal` (which internally includes `tashkeel` and morphological analyzers `qalsadi` / `arrane`; do NOT install a separate package named `adawat`).
  - Pin all packages in `backend/requirements.txt` using `==` (e.g., `fastapi==0.110.0`, `uvicorn==0.28.0`, `onnxruntime==1.17.1`, `python-docx==1.1.0`, `pyarabic==0.6.15`, `mishkal==0.4.1`, `pydantic==2.6.4`, `pytest==8.1.1`, `ruff==0.3.2`).
- **Node.js (`20.11.0`):**
  - Enforce `"engines": { "node": ">=20.11.0" }` in `desktop/package.json`.
  - Use **CodeMirror 6 (`@codemirror/view`, `@codemirror/state`)** for the main editor instead of TipTap/ProseMirror, because CodeMirror 6 natively supports **viewport virtual scrolling** for 100-page documents, RTL bidirectional text, and non-destructive **OpenType `COLR/CPAL` colored diacritic fonts** without breaking DOM cursor positions or Arabic ligatures.

---

## 3. Deterministic Mock Mode Strategy (`MIZAJ_ENGINE_MODE=mock`)
Cloud CI runners and AI Agent VMs (such as Google Jules) do not have pre-downloaded 180MB `.onnx` weights in Git.
- **Activation:** Activated when environment variable `MIZAJ_ENGINE_MODE=mock` is set OR when `backend/models/catt_encoder_int8.onnx` is missing on disk.
- **Deterministic Behavior:**
  - In `mock` mode, the engine applies a deterministic rule-based vowelizer: it strips existing non-locked diacritics using `pyarabic.araby.strip_tashkeel`, looks up words in `tashkeel_cache` (SQLite), and for uncached Arabic words appends a deterministic fatha (`َ`) on the first letter and damma (`ُ`) on the last letter (e.g., `كتاب` -> `كَتابُ`).
  - For `/api/word-suggestions?word=علم`, `mock` mode returns a deterministic 3-item JSON list: `[{"diacritized": "عِلْمٌ", "pos": "اسم - مرفوع"}, {"diacritized": "عَلِمَ", "pos": "فعل ماض"}, {"diacritized": "عَلَمٌ", "pos": "اسم"}]`.
- **Testing:** All `pytest` and `Playwright` tests must assert against this deterministic output when `MIZAJ_ENGINE_MODE=mock`.

---

## 4. Error Handling, Crash Recovery & Unified Logging
1. **Python Sidecar Crash Recovery:**
   - Electron's `PythonProcessManager` monitors the child process `exit` event. If the Python process crashes unexpectedly (`code !== 0` and app is not quitting), Electron automatically restarts the sidecar with exponential backoff (1s, 2s, 4s, max 3 retries) and emits an IPC event `sidecar:status-changed` to the Vue UI.
2. **SSE Stream Interruption Recovery:**
   - Batch document diacritization uses **Server-Sent Events (SSE)** (`POST /api/tashkeel/stream` over HTTP/1.1, bound strictly to `127.0.0.1`). Each chunk processed is immediately saved to SQLite `tashkeel_cache`. If SSE disconnects mid-document, clicking "Resume" skips already-cached chunks and finishes in seconds.
3. **Disk & Permission Errors on DOCX Export:**
   - Before writing `.docx`, backend writes to a temporary file in the same directory (`.~mizaj_tmp.docx`) and performs an atomic `os.replace()`. If `PermissionError` (e.g., file is open in MS Word) or `ENOSPC` occurs, return structured error code `ERR_DOCX_WRITE_LOCKED` (`423 Locked`) so the UI prompts the user to close Word or pick another path.
4. **Unified Logging & Rotation:**
   - Both Electron (`electron-log`) and Python (`logging.handlers.RotatingFileHandler`, max `5MB` per file, `5` backups) write structured JSON/text logs to `<userData>/logs/mizaj-main.log` and `<userData>/logs/mizaj-backend.log` with levels `DEBUG`, `INFO`, `WARN`, `ERROR`.

---

## 5. Security & Privacy Policy
- **Zero Telemetry & Zero Network Egress:** The application makes ZERO external HTTP calls at runtime. FastAPI binds exclusively to `127.0.0.1` on an OS-assigned ephemeral port (`--port 0`, printing `MIZAJ_PORT=<port>` to `stdout` on startup).
- **Windows Console Hiding:** Electron `spawn()` MUST always set `windowsHide: true` to prevent a black `cmd.exe` window on Windows.

---

## 6. Architecture Reference Docs
Read [`docs/architecture/data-flow.md`](./docs/architecture/data-flow.md), [`docs/architecture/threading-model.md`](./docs/architecture/threading-model.md), and [`docs/architecture/error-codes.md`](./docs/architecture/error-codes.md) before implementing backend or IPC modules.
