"""Fast-mode engine on mishkal + qalsadi analysis helpers (shared by the morph filter)."""

from __future__ import annotations

import logging
import tempfile
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

from app.engine import config
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


def _cache_dir() -> Path:
    base = config.get_data_dir() or Path(tempfile.gettempdir()) / "mizaj"
    d = Path(base) / "cache"
    d.mkdir(parents=True, exist_ok=True)
    return d


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
        self._passive: dict[str, frozenset[str]] = {}
        self._candidates = lru_cache(maxsize=50000)(self._candidates_uncached)

    def _init_libs(self) -> None:
        import sylajone.cache as sylajone_cache
        from mishkal.tashkeel import TashkeelClass
        from qalsadi.analex import Analex

        # sylajone's syntax-analyzer cache defaults to ~/.thaalabCache; redirect it into the
        # data dir (class attribute, read at construction time) so nothing is written to $HOME.

        sylajone_cache.cache.DB_PATH = str(_cache_dir() / ".thaalabCache")
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
        passive: set[str] = set()
        for group in result:
            for sw in group:
                voc = sw.vocalized
                if not voc or strip_marks(voc) != word:
                    continue
                if "المجهول" in (sw.tags or ""):
                    passive.add(voc)
                freq = int(getattr(sw, "freq", 0) or 0)
                if voc not in seen or freq > seen[voc][2]:
                    seen[voc] = (voc, _pos_description(sw), freq)
        self._passive[word] = frozenset(passive)
        return tuple(seen.values())

    def passive_vocalizations(self, word: str) -> frozenset[str]:
        """Vocalizations of `word` that qalsadi analyses as passive-voice verbs."""
        bare = strip_marks(word)
        self._candidates(bare)
        return self._passive.get(bare, frozenset())

    def is_passive_form(self, bare: str, diacritized: str) -> bool:
        """True if `diacritized` (case ending ignored) equals a passive-verb vocalization."""
        from app.engine.normalize import last_letter_split

        want = last_letter_split(diacritized)[0]
        return any(last_letter_split(v)[0] == want for v in self.passive_vocalizations(bare))

    def candidates(self, word: str) -> tuple[tuple[str, str, int], ...]:
        return self._candidates(strip_marks(word))

    def diacritize_scored(self, words, lookup=None):
        """Confidence from the analysis: one candidate vocalization -> high; several distinct
        internal patterns -> 1/n; unknown word -> low. The case ending is only trusted when the
        word has a single analysis (mishkal's context handling of i'rab is weak)."""
        outs = self.diacritize(words, lookup)
        confs = []
        for w in words:
            cands = self.candidates(w)
            if not cands:
                confs.append((0.4, 0.4))
                continue
            patterns = set()
            for voc, _, _ in cands:
                pairs = split_pairs(voc)
                patterns.add(tuple(m.replace(SHADDA, "") for _, m in pairs[:-1]))
            wc = 0.95 if len(patterns) == 1 else max(0.2, 1.0 / len(patterns))
            ic = 0.95 if len(cands) == 1 else 0.4
            confs.append((wc, ic))
        return outs, confs

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


def _noun_only(self: MishkalEngine, word: str) -> bool:
    """True if every qalsadi analysis of `word` is a noun (so a case rule may apply)."""
    cands = self.candidates(word)
    return bool(cands) and all(pos.startswith("اسم") for _, pos, _ in cands)


MishkalEngine.is_noun_only = _noun_only  # type: ignore[attr-defined]


def _analyses(self: MishkalEngine, word: str) -> list[dict]:
    """Full qalsadi analyses of a bare word (vocalized, kind, tags, root, lemma, freq)."""
    bare = strip_marks(word)
    cache = self.__dict__.setdefault("_analysis_cache", {})
    if bare not in cache:
        result = self._pool.submit(self._analex.check_text, bare).result()
        out = []
        for group in result:
            for sw in group:
                if not sw.vocalized or strip_marks(sw.vocalized) != bare:
                    continue
                out.append(
                    {
                        "vocalized": sw.vocalized,
                        "type": sw.type or "",
                        "tags": sw.tags or "",
                        "root": getattr(sw, "root", "") or "",
                        "lemma": getattr(sw, "original", "") or "",
                        "freq": int(getattr(sw, "freq", 0) or 0),
                    }
                )
        if len(cache) > 20000:
            cache.clear()
        cache[bare] = out
    return cache[bare]


MishkalEngine.analyses = _analyses  # type: ignore[attr-defined]
