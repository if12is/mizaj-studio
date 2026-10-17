"""tashkeel_cache access: user-locked words win, chunk-level engine results are memoised."""

from __future__ import annotations

import hashlib
import sqlite3
from collections import Counter
from collections.abc import Iterable

from app.core.database import now_iso, write

CHUNK_PREFIX = "\x1fchunk:"
_BATCH = 400


def chunk_key(tag: str, stripped_text: str) -> str:
    digest = hashlib.sha256(stripped_text.encode("utf-8")).hexdigest()[:40]
    return f"{CHUNK_PREFIX}{tag}:{digest}"


class TashkeelCache:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn

    def _fetch(self, words: Iterable[str], locked_only: bool) -> dict[str, tuple[int, str]]:
        words = sorted(set(words))
        found: dict[str, tuple[int, str]] = {}
        extra = " AND is_user_locked=1" if locked_only else ""
        for i in range(0, len(words), _BATCH):
            part = words[i : i + _BATCH]
            marks = ",".join("?" * len(part))
            rows = self.conn.execute(
                "SELECT id, word_or_phrase, diacritized_form FROM tashkeel_cache "  # noqa: S608
                f"WHERE word_or_phrase IN ({marks}){extra}",
                part,
            ).fetchall()
            for r in rows:
                found[r["word_or_phrase"]] = (r["id"], r["diacritized_form"])
        return found

    def locked_words(self, words: Iterable[str]) -> dict[str, str]:
        """User-locked dictionary forms (these always win)."""
        return {w: f for w, (_, f) in self._fetch(words, True).items()}

    def any_words(self, words: Iterable[str]) -> dict[str, str]:
        """Any cached word form (locked rows included); chunk rows never collide (prefixed)."""
        return {w: f for w, (_, f) in self._fetch(words, False).items()}

    def bump_words(self, occurrences: Counter[str]) -> None:
        if not occurrences:
            return
        ts = now_iso()
        with write(self.conn):
            self.conn.executemany(
                "UPDATE tashkeel_cache SET usage_count=usage_count+?, updated_at=? "
                "WHERE word_or_phrase=? AND is_user_locked=1",
                [(n, ts, w) for w, n in occurrences.items()],
            )

    def get_chunk(self, tag: str, stripped: str) -> str | None:
        key = chunk_key(tag, stripped)
        row = self.conn.execute(
            "SELECT diacritized_form FROM tashkeel_cache WHERE word_or_phrase=?", (key,)
        ).fetchone()
        if row is None:
            return None
        with write(self.conn):
            self.conn.execute(
                "UPDATE tashkeel_cache SET usage_count=usage_count+1 WHERE word_or_phrase=?",
                (key,),
            )
        return row["diacritized_form"]

    def put_chunk(self, tag: str, stripped: str, result: str) -> None:
        self.put_entry(chunk_key(tag, stripped), result)

    def put_entry(self, key: str, form: str) -> None:
        """Store an engine result (source='engine'); never touches user-locked rows."""
        ts = now_iso()
        with write(self.conn):
            self.conn.execute(
                "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form, source, "
                "is_user_locked, created_at, updated_at) VALUES (?,?,'engine',0,?,?) "
                "ON CONFLICT(word_or_phrase) DO UPDATE SET "
                "diacritized_form=excluded.diacritized_form, updated_at=excluded.updated_at "
                "WHERE tashkeel_cache.is_user_locked=0",
                (key, form, ts, ts),
            )
