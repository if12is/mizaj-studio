"""Proper-noun dictionary (Task 7.4.3): common Arabic names/places with their diacritization.

Applied after the engine at every level, below the user's dictionary and typed marks. Like the
legal glossary it supplies internal vowels and shadda only; the case ending stays the engine's.
Users extend/disable entries through the `proper_nouns` table.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from app.legal.glossary import Entry, GlossaryIndex, validate_entry

DATA = Path(__file__).resolve().parent / "data" / "names.json"


def builtin_names() -> list[Entry]:
    raw = json.loads(DATA.read_text(encoding="utf-8"))["entries"]
    return [Entry(e["term"], e["diacritized"], note=e.get("kind", ""), builtin=True) for e in raw]


def load_names(conn: sqlite3.Connection | None) -> list[Entry]:
    merged = {e.term: e for e in builtin_names()}
    if conn is not None:
        for r in conn.execute("SELECT * FROM proper_nouns ORDER BY id"):
            if r["enabled"]:
                merged[r["term"]] = Entry(r["term"], r["diacritized"], note=r["kind"], id=r["id"])
            else:
                merged.pop(r["term"], None)
    return list(merged.values())


def names_index(conn: sqlite3.Connection) -> GlossaryIndex:
    return GlossaryIndex(load_names(conn))


__all__ = ["builtin_names", "load_names", "names_index", "validate_entry"]
