-- Document edit history (سجل التعديلات): compressed full-text snapshots per document.
CREATE TABLE document_versions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    kind          TEXT NOT NULL DEFAULT 'autosave'
                  CHECK (kind IN ('autosave', 'event', 'checkpoint', 'restore', 'initial')),
    label         TEXT NOT NULL DEFAULT '',
    name          TEXT NOT NULL DEFAULT '',
    content_hash  TEXT NOT NULL,
    content_z     BLOB NOT NULL,
    char_count    INTEGER NOT NULL DEFAULT 0,
    word_count    INTEGER NOT NULL DEFAULT 0,
    words_added   INTEGER NOT NULL DEFAULT 0,
    words_removed INTEGER NOT NULL DEFAULT 0,
    chars_delta   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_versions_doc ON document_versions(document_id, id);
