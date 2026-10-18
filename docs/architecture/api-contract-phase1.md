# Phase 1 API Contract (backend ⇄ desktop)

Base URL: `http://127.0.0.1:<MIZAJ_PORT>`. All JSON. Timestamps are ISO-8601 UTC strings.
Errors use the envelope from `error-codes.md`: `{error_code, message_ar, message_en, details}`.
Extra Phase-1 codes: `ERR_NOT_FOUND` (404), `ERR_VALIDATION` (422), `ERR_DUPLICATE_WORD` (409).

## Sidecar
- CLI: `python -m app.main --host 127.0.0.1 --port 0 --data-dir <dir>` (run from `backend/`).
- stdout (flushed, each on its own line, after the socket is bound): `MIZAJ_PORT=<port>` then `MIZAJ_STATUS=READY`.
- DB file: `<data-dir>/mizaj.db`; backups: `<data-dir>/backups/mizaj-<UTCstamp>-v<old_version>.db`.
- Logs: `<data-dir>/logs/mizaj-backend.log` (RotatingFileHandler 5MB × 5).
- `GET /health` → `{"status":"ok","version":"0.1.0","engine_mode":"mock"|"real","db_user_version":1}`

## Projects
- `GET /api/projects` → `Project[]` (ordered by `updated_at` desc)
- `POST /api/projects` body `{name, description?}` → 201 `Project`
- `GET /api/projects/{id}` → `Project`
- `PUT /api/projects/{id}` body `{name?, description?}` → `Project`
- `DELETE /api/projects/{id}` → 204 (cascades documents)
- `Project = {id, name, description, created_at, updated_at}`

## Documents
- `GET /api/documents?project_id=<id>` → `DocumentSummary[]` (excludes `is_deleted=1`; no content fields)
- `POST /api/documents` body `{project_id, title, raw_content?, language?="ar", direction?="rtl"}` → 201 `Document`
- `GET /api/documents/{id}` → `Document`
- `PUT /api/documents/{id}` body `{title?, raw_content?, diacritized_content?}` → `Document` (server recomputes `word_count`)
- `DELETE /api/documents/{id}` → 204 (soft delete: `is_deleted=1`)
- `Document = {id, project_id, title, raw_content, diacritized_content, source_docx_path, language, direction, word_count, is_deleted, created_at, updated_at}`
- `DocumentSummary` = Document without `raw_content` / `diacritized_content`.

## Settings
- `GET /api/settings` → `{[key]: value}` merged over defaults:
  `{"engine_mode":"fast","tashkeel_level":"full","editor_font":"Amiri","editor_font_size":"20","colored_diacritics":"true","theme":"dark"}`
- `PUT /api/settings` body `{[key]: string}` (partial upsert) → full settings map.
  Validation: `engine_mode ∈ {fast,accurate}`, `tashkeel_level ∈ {full,irab_only,essential,minimal,legal}`, `theme ∈ {dark,light}`, `editor_font_size` integer 12–48, `colored_diacritics ∈ {true,false}`.

## Personal dictionary (rows of `tashkeel_cache` with `is_user_locked=1`)
- `GET /api/dictionary?q=<search>` → `DictEntry[]`
- `POST /api/dictionary` body `{word_or_phrase, diacritized_form}` → 201 `DictEntry`; `source='user'`, `is_user_locked=1`.
  If the word exists as an unlocked engine row → it is upgraded to a locked user row (201). If it already exists as a locked row → 409 `ERR_DUPLICATE_WORD`.
- `PUT /api/dictionary/{id}` body `{diacritized_form}` → `DictEntry`
- `DELETE /api/dictionary/{id}` → 204
- `POST /api/dictionary/import` body `{entries:[{word_or_phrase, diacritized_form}]}` → `{imported, updated}` (upsert)
- `GET /api/dictionary/export` → `{version:1, entries:[{word_or_phrase, diacritized_form}]}`
- `DictEntry = {id, word_or_phrase, diacritized_form, source, is_user_locked, usage_count, created_at, updated_at}`

## Electron IPC (preload `window.mizajAPI`)
- `getBackendConfig(): Promise<{port:number|null, baseUrl:string|null, status:SidecarStatus}>`
- `onSidecarStatus(cb:(s:SidecarStatus)=>void): () => void` — channel `sidecar:status-changed`
- `SidecarStatus = {state:'starting'|'ready'|'restarting'|'crashed'|'stopped', port:number|null, retry:number, message?:string}`
- Window controls: `windowMinimize()`, `windowToggleMaximize()`, `windowClose()`
- `onBeforeQuitFlush(cb: () => Promise<void>)` — main asks renderer to flush autosave before closing (channel `app:flush-request` / reply `app:flush-done`, 2s timeout).
