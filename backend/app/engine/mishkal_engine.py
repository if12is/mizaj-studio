"""Fast-mode engine on mishkal + qalsadi analysis helpers (shared by the morph filter)."""

from __future__ import annotations

import logging
import threading
from functools import lru_cache

from app.engine.base import Engine, Lookup
from app.engine.normalize import strip_marks

log = logging.getLogger("mizaj.engine.mishkal")

CASE_AR = {
    "ُ": "مرفوع",
    "ٌ": "مرفوع",
    "َ": "منصوب",
    "ً": "منصوب",
    "ِ": "مجرور",
    "ٍ": "مجرور",
}


def _pos_description(sw) -> str:
    kind = (sw.type or "").split(":")[0]
    head = (sw.tags or "").split(":")[0].strip()
    if kind.startswith("Verb"):
        return f"فعل - {head}" if head else "فعل"
    if kind.startswith("Noun"):
        return f"اسم - {head}" if head else "اسم"
    if kind.startswith("STOPWORD"):
        return "أداة/كلمة وظيفية"
    return kind or "غير محدد"


class MishkalEngine(Engine):
    name = "mishkal"
    cache_tag = "mishkal"

    def __init__(self) -> None:
        # Both libraries keep internal caches/state: serialise access.
        self._lock = threading.Lock()
        from mishkal.tashkeel import TashkeelClass
        from qalsadi.analex import Analex

        self._tashkeel = TashkeelClass()
        self._analex = Analex()
        self._candidates = lru_cache(maxsize=50000)(self._candidates_uncached)

    def diacritize(self, words: list[str], lookup: Lookup | None = None) -> list[str]:
        if not words:
            return []
        with self._lock:
            out = self._tashkeel.tashkeel(" ".join(words)).split()
            if len(out) != len(words):
                log.debug("mishkal word count mismatch; falling back to per-word")
                out = [(self._tashkeel.tashkeel(w).split() or [w])[0] for w in words]
        return out

    def _candidates_uncached(self, word: str) -> tuple[tuple[str, str, int], ...]:
        """(vocalized, pos_description, freq) for each distinct analysis of `word`."""
        with self._lock:
            result = self._analex.check_text(word)
        seen: dict[str, tuple[str, str, int]] = {}
        for group in result:
            for sw in group:
                voc = sw.vocalized
                if not voc or strip_marks(voc) != word:
                    continue
                freq = int(getattr(sw, "freq", 0) or 0)
                if voc not in seen or freq > seen[voc][2]:
                    seen[voc] = (voc, _pos_description(sw), freq)
        return tuple(seen.values())

    def candidates(self, word: str) -> tuple[tuple[str, str, int], ...]:
        return self._candidates(strip_marks(word))

    def suggestions(self, word: str) -> list[dict[str, str]]:
        cands = sorted(self.candidates(word), key=lambda c: -c[2])
        return [{"diacritized": v, "pos": pos} for v, pos, _ in cands[:15]]
