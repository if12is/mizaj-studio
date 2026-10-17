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
