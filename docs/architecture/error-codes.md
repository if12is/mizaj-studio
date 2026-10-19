# Architecture: Unified Error Codes (`error-codes.md`)

All FastAPI error responses follow a strict JSON envelope:
```json
{
  "error_code": "ERR_DOCX_WRITE_LOCKED",
  "message_ar": "تعذر حفظ ملف الوورد لأن الملف مفتوح حالياً في برنامج آخر.",
  "message_en": "Cannot write DOCX file because it is locked by another process.",
  "details": {}
}
```

| Error Code | HTTP Status | Trigger Condition | Recovery Action in UI |
| :--- | :--- | :--- | :--- |
| `ERR_ENGINE_NOT_READY` | `503` | Models are still loading into RAM | Show loading spinner and retry in 1s |
| `ERR_MODEL_MISSING` | `500` | `.onnx` file missing and not in mock mode | Prompt user to run model repair/switch to Fast mode |
| `ERR_DOCX_CORRUPT` | `422` | Uploaded `.docx` is not a valid ZIP/XML archive | Alert user that the Word file is corrupted |
| `ERR_DOCX_WRITE_LOCKED` | `423` | Target `.docx` is open in MS Word or read-only | Prompt user to close MS Word or choose a new filename |
| `ERR_DISK_FULL` | `507` | `ENOSPC` during SQLite or DOCX save | Alert user to free disk space |
| `ERR_DB_MIGRATION_FAILED`| `500` | SQLite schema migration failed on startup | Backup `.db` file automatically and alert user |
| `ERR_TASK_CANCELLED` | `499` | User clicked Cancel during batch SSE stream | Keep already processed chunks in cache and stop stream |
| `ERR_UNAUTHORIZED` | `401` | Missing/invalid `X-Mizaj-Token` (per-launch token from Electron) | Internal: client reloads config from main and retries once |
| `ERR_HOST_NOT_ALLOWED` | `421` | `Host` header is not `127.0.0.1` / `localhost` (DNS-rebinding protection) | None (request is rejected) |
| `ERR_PAYLOAD_TOO_LARGE` | `413` | Request body over 64 MiB or a field over its length limit | Ask the user to split the document |
| `ERR_FILE_TOO_LARGE` | `413` | Input file over the per-format size limit | Show the limit and suggest another file |
| `ERR_PIPER_MISSING` | `409` | Piper read-aloud selected but the optional engine/voice resource is not installed | Offer the download in Settings; fall back to the system voice |
| `ERR_PIPER_BLOCKED` | `409` | `piper.exe` is missing after install or blocked (Windows Defender quarantine, `ERROR_VIRUS_INFECTED`) | Explain Defender, point to `WINDOWS_DEFENDER.md`; fall back to the system voice |
| `ERR_PIPER_SPAWN_FAILED` | `500` | `piper.exe` could not be started (permissions, other OS error) | Fall back to the system voice |
| `ERR_PIPER_FAILED` | `500` | Piper exited non-zero or produced no valid WAV | Fall back to the system voice |
| `ERR_PIPER_TIMEOUT` | `504` | One sentence took longer than 60 s to synthesize | Fall back to the system voice |
