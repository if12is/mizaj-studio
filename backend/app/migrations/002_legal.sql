-- Phase 7 legal tools: user glossary + document templates
CREATE TABLE legal_glossary (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    term         TEXT NOT NULL,
    diacritized  TEXT NOT NULL,
    preferred    TEXT NOT NULL DEFAULT '',
    avoid_json   TEXT NOT NULL DEFAULT '[]',
    definition   TEXT NOT NULL DEFAULT '',
    jurisdiction TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_legal_glossary_term ON legal_glossary(term);

CREATE TABLE legal_templates (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT '',
    jurisdiction TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL,
    vars_json    TEXT NOT NULL DEFAULT '[]',
    version      INTEGER NOT NULL DEFAULT 1,
    is_sample    INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_legal_templates_category ON legal_templates(category);

-- internal flags for the legal module (e.g. "starter templates already seeded")
CREATE TABLE legal_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
