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
