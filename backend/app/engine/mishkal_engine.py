"""Fast-mode engine on mishkal + qalsadi analysis helpers (shared by the morph filter)."""

from __future__ import annotations

import logging
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

from app.engine.base import Engine, Lookup
from app.engine.normalize import SHADDA, split_pairs, strip_marks

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
        # mishkal/qalsadi keep sqlite handles (check_same_thread) and internal caches, so every
        # call is confined to ONE dedicated thread (which also serialises access). The outer
        # pipeline still runs inside the shared engine executor; it only waits on this thread.
        self._pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mizaj-mishkal")
        self._pool.submit(self._init_libs).result()
        self._candidates = lru_cache(maxsize=50000)(self._candidates_uncached)

    def _init_libs(self) -> None:
        from mishkal.tashkeel import TashkeelClass
        from qalsadi.analex import Analex

        self._tashkeel = TashkeelClass()
        self._analex = Analex()

    def diacritize(self, words: list[str], lookup: Lookup | None = None) -> list[str]:
        if not words:
            return []
        return self._pool.submit(self._diacritize, words).result()

    def _diacritize(self, words: list[str]) -> list[str]:
        out = self._tashkeel.tashkeel(" ".join(words)).split()
        if len(out) != len(words):
            log.debug("mishkal word count mismatch; falling back to per-word")
            out = [(self._tashkeel.tashkeel(w).split() or [w])[0] for w in words]
        return out

    def _candidates_uncached(self, word: str) -> tuple[tuple[str, str, int], ...]:
        """(vocalized, pos_description, freq) for each distinct analysis of `word`."""
        result = self._pool.submit(self._analex.check_text, word).result()
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

    def is_ambiguous(self, word: str) -> bool:
        """>1 common vocalization: among candidates with freq>0 (all, if none has freq>0),
        count distinct internal vowel patterns (last-letter case ending and shadda ignored).
        Unknown words have no vocalization and count as unambiguous."""
        cands = self.candidates(word)
        common = [c for c in cands if c[2] > 0] or list(cands)
        patterns = set()
        for voc, _, _ in common:
            pairs = split_pairs(voc)
            patterns.add(tuple(m.replace(SHADDA, "") for _, m in pairs[:-1]))
        return len(patterns) > 1

    def suggestions(self, word: str) -> list[dict[str, str]]:
        cands = sorted(self.candidates(word), key=lambda c: -c[2])
        return [{"diacritized": v, "pos": pos} for v, pos, _ in cands[:15]]


def _quiet_third_party_del_errors() -> None:
    """mishkal's dictionaries close sqlite handles in __del__ from another thread at GC /
    interpreter exit; that is harmless noise, so drop exactly that unraisable error."""
    import sqlite3
    import sys

    previous = sys.unraisablehook

    def hook(args):
        exc = args.exc_value
        if isinstance(exc, sqlite3.ProgrammingError) and "same thread" in str(exc):
            return
        previous(args)

    sys.unraisablehook = hook


_quiet_third_party_del_errors()
