-- Phase 1 initial schema (plan Task 1.3.3)
CREATE TABLE projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE documents (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title               TEXT NOT NULL,
    raw_content         TEXT NOT NULL DEFAULT '',
    diacritized_content TEXT NOT NULL DEFAULT '',
    source_docx_path    TEXT,
    language            TEXT NOT NULL DEFAULT 'ar',
    direction           TEXT NOT NULL DEFAULT 'rtl',
    word_count          INTEGER NOT NULL DEFAULT 0,
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_documents_project_deleted ON documents(project_id, is_deleted);

CREATE TABLE tashkeel_cache (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    word_or_phrase   TEXT NOT NULL,
    diacritized_form TEXT NOT NULL,
    source           TEXT NOT NULL DEFAULT 'engine'
                     CHECK (source IN ('user', 'engine', 'dictionary')),
    is_user_locked   INTEGER NOT NULL DEFAULT 0,
    usage_count      INTEGER NOT NULL DEFAULT 1,
    created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_cache_word_unique ON tashkeel_cache(word_or_phrase);
CREATE INDEX idx_cache_locked ON tashkeel_cache(is_user_locked);

CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE recent_files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path      TEXT NOT NULL UNIQUE,
    document_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    last_opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_recent_opened ON recent_files(last_opened_at);
