-- Phase 7 engine quality: learning from corrections + user proper nouns
CREATE TABLE corrections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    word        TEXT NOT NULL,              -- bare (undiacritized) word
    engine_form TEXT NOT NULL,              -- what the engine produced (last seen)
    user_form   TEXT NOT NULL,              -- what the user changed it to
    count       INTEGER NOT NULL DEFAULT 1,
    dismissed   INTEGER NOT NULL DEFAULT 0,
    last_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_corrections_pair ON corrections(word, user_form);

CREATE TABLE proper_nouns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    term        TEXT NOT NULL,
    diacritized TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX idx_proper_nouns_term ON proper_nouns(term);
