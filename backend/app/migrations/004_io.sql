-- Phase 7 import/export: undo journal for .mizajpack v2 imports
CREATE TABLE pack_imports (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    name         TEXT NOT NULL DEFAULT '',
    version      TEXT NOT NULL DEFAULT '',
    content_sha256 TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'undone')),
    summary_json TEXT NOT NULL DEFAULT '{}',
    journal_json TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    undone_at    TEXT
);
