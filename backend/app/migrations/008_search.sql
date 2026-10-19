-- Full-text search across all documents (Ctrl+Shift+F, palette «في المحتوى»).
-- `document_search` holds a NORMALIZED shadow of each document (no diacritics / tatweel,
-- folded hamza, ya and ta-marbuta; see app/core/search.py), keyed by rowid = documents.id.
-- Normalization happens in Python, so the index is filled by the app (on save and, for rows
-- that predate this migration, at startup via search.ensure_index); the meta table records
-- what has been indexed so a stale or missing row is detected cheaply.
CREATE VIRTUAL TABLE document_search USING fts5(
    title_norm,
    body_norm,
    tokenize = 'unicode61 remove_diacritics 0'
);
CREATE TABLE document_search_meta (
    document_id    INTEGER PRIMARY KEY,
    src_updated_at TEXT NOT NULL
);
