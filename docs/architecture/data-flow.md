# Architecture: End-to-End Data Flow (`data-flow.md`)

## 1. Sidecar Startup & Dynamic Port Handshake
1. Electron `main.ts` launches Python executable/script with arguments: `python -m app.main --host 127.0.0.1 --port 0 --data-dir "<app.getPath('userData')>"` and option `windowsHide: true`.
2. Uvicorn binds to `127.0.0.1:0` (OS assigns an available free ephemeral port, e.g., `54321`).
3. FastAPI startup hook prints `MIZAJ_PORT=54321` and `MIZAJ_STATUS=READY` to `stdout` and flushes the buffer.
4. Electron `PythonProcessManager` parses `MIZAJ_PORT` from `stdout`, stores it in memory, and exposes it to the Vue 3 Renderer via `preload/index.ts` (`window.mizajAPI.getBackendConfig()`).

## 2. Interactive Text Diacritization Flow (SSE)
```text
[Vue 3 CodeMirror 6 Editor]
       │ (1) User clicks "تشكيل المقال" (POST /api/tashkeel/stream)
       ▼
[FastAPI Controller (127.0.0.1:<port>)]
       │ (2) ArabicSentenceSplitter splits text into chunks (<= 256 chars, matching CATT 512 token limit)
       ▼
[SQLite Lookup Cache (WAL Mode)]
       │ (3) Immediate hit for locked/cached words & sentences (< 1ms)
       ▼
[Hybrid Engine Worker Pool]
       ├─► Fast Mode: `libtashkeel` (Rust FFI)
       └─► Accurate Mode: `CATT ONNX INT8` (CPU) ──► `Mishkal` Morphological Sanity Filter
       │
       ▼ (4) Yields SSE event: `data: {"chunk_id": 1, "text": "...", "progress": 15, "wps": 1420}`
[Vue 3 Renderer]
       └─► Replaces chunk in CodeMirror 6 Transaction (preserving Undo/Redo history)
```

## 3. Colored Diacritics Rendering Architecture (Proof-of-Concept Validated)
Because Arabic diacritics (`ً`–`ْ`) are Unicode combining marks, wrapping them in `<span class="diacritic">` breaks cursive shaping (ligatures) in Chromium/Blink.
- **Chosen Solution:** Custom **OpenType `COLR`/`CPAL` Multi-Palette Variable Font** (`Amiri-Mizaj-Colr.woff2`).
- In this font, base glyphs use `currentColor` (inheriting dark/light text color), while combining mark glyphs (`fatha`, `damma`, `kasra`, `shadda`, `sukun`) are assigned to `CPAL` Palette Entry `0` (Emerald `#10B981` or Amber `#F59E0B`).
- Toggling colored diacritics on/off is a pure CSS operation (`font-palette: --mizaj-colored;` vs `font-palette: normal;`) with **zero DOM manipulation**, **100% intact copy/paste**, and **60 FPS scrolling**.
