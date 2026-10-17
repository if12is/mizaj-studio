"""Dictionary engine: Hunspell (ayaspell) + arramooz lexicon + Arabic-aware suggestions."""

from __future__ import annotations

import math
import sqlite3
import sys
import threading
from pathlib import Path

from .hunspell_lite import HunspellLite
from .text import strip_for_lookup

DATA_DIR = Path(__file__).parent / "data"
ALPHABET = "ابتثجحخدذرزسشصضطظعغفقكلمنهويةىءأإآؤئ"
# substitution groups that cost little (typical Arabic orthographic confusions)
_GROUPS = ("اأإآ", "ءأؤئ", "ةه", "يىئ", "ضظ", "ظز", "سص", "تط", "ذدز", "ثست", "غع", "حهخ", "قك")
_SUB_COST: dict[tuple[str, str], float] = {}
for _g in _GROUPS:
    for _a in _g:
        for _b in _g:
            if _a != _b:
                _SUB_COST[(_a, _b)] = min(
                    _SUB_COST.get((_a, _b), 1.0),
                    0.25
                    if _g[:2] in ("اأ", "ءأ", "ةه", "يى") or _g in ("اأإآ", "ءأؤئ", "ةه", "يىئ")
                    else 0.6,
                )
CHEAP_INS = "اويةهءى"
PROCLITICS = (
    "",
    "و",
    "ف",
    "ب",
    "ل",
    "ك",
    "ال",
    "وال",
    "فال",
    "بال",
    "كال",
    "لل",
    "ولل",
    "فلل",
    "وب",
    "وك",
    "ول",
    "فب",
    "فل",
    "ولل",
    "س",
    "وس",
    "فس",
)


def _lexicon_paths() -> list[Path]:
    names = ("arabicdictionary.sqlite", "stopwords.sqlite", "wordfreq.sqlite")
    cands: list[Path] = []
    for base in (Path(sys.prefix) / "data", Path(getattr(sys, "_MEIPASS", "")) / "data"):
        cands.append(base)
    try:
        import arramooz

        cands.append(Path(arramooz.__file__).parent / "data")
    except Exception:  # noqa: BLE001 - lexicon is optional
        pass
    for base in cands:
        if all((base / n).exists() for n in names):
            return [base / n for n in names]
    return []


def _load_lexicon() -> tuple[set[str], dict[str, int]]:
    words: set[str] = set()
    freq: dict[str, int] = {}
    paths = _lexicon_paths()
    queries = (
        ("SELECT unvocalized FROM nouns", False),
        ("SELECT unvocalized FROM verbs", False),
        ("SELECT UNVOCALIZED FROM STOPWORDS", False),
        ("SELECT unvocalized, freq FROM wordfreq", True),
    )
    for path, (sql, has_freq) in zip(paths, [queries[0], queries[2], queries[3]], strict=False):
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            for row in con.execute(sql):
                k = strip_for_lookup(row[0] or "")
                if k:
                    words.add(k)
                    if has_freq:
                        freq[k] = max(freq.get(k, 0), int(row[1] or 0))
            if path.name.startswith("arabic"):
                for row in con.execute(queries[1][0]):
                    k = strip_for_lookup(row[0] or "")
                    if k:
                        words.add(k)
        finally:
            con.close()
    return words, freq


class SpellEngine:
    def __init__(self) -> None:
        self.hs = HunspellLite.load(DATA_DIR / "ar.aff", DATA_DIR / "ar.dic.gz")
        try:
            self.lex, self.freq = _load_lexicon()
        except Exception:  # noqa: BLE001 - never fail spelling because the lexicon is missing
            self.lex, self.freq = set(), {}
        self._valid: dict[str, bool] = {}
        self._sugg: dict[str, list[str]] = {}

    # ---------------------------------------------------------------- validity
    def lexicon_known(self, key: str) -> bool:
        if key in self.lex:
            return True
        for p in PROCLITICS[1:]:
            if key.startswith(p) and len(key) - len(p) >= 3 and key[len(p) :] in self.lex:
                return True
        return False

    def strong_valid(self, key: str) -> bool:
        """Stricter than is_valid: a stem of the dictionary or a lexicon lemma (+ clitics)."""
        if key in self.hs.stems or self.lexicon_known(key):
            return True
        for p in PROCLITICS[1:]:
            if key.startswith(p) and len(key) - len(p) >= 3 and key[len(p) :] in self.hs.stems:
                return True
        return False

    def is_valid(self, key: str) -> bool:
        """Dictionary-valid (Hunspell or lexicon). `key` has no marks/tatweel."""
        v = self._valid.get(key)
        if v is None:
            v = self.hs.check(key) or self.lexicon_known(key)
            if len(self._valid) > 300_000:
                self._valid.clear()
            self._valid[key] = v
        return v

    # ---------------------------------------------------------------- suggestions
    @staticmethod
    def _sub_cost(a: str, b: str) -> float:
        return _SUB_COST.get((a, b), 1.0)

    def _edits1(self, w: str, cheap_only: bool):
        n = len(w)
        for i in range(n):
            if not cheap_only or w[i] in CHEAP_INS:
                if n > 2:
                    yield w[:i] + w[i + 1 :], 0.9 if w[i] in CHEAP_INS else 1.0
            for c in ALPHABET:
                if c != w[i]:
                    cost = self._sub_cost(w[i], c)
                    if cheap_only and cost >= 1.0:
                        continue
                    yield w[:i] + c + w[i + 1 :], cost
        if not cheap_only:
            for i in range(n - 1):
                if w[i] != w[i + 1]:
                    yield w[:i] + w[i + 1] + w[i] + w[i + 2 :], 0.8
        ins = CHEAP_INS if cheap_only else ALPHABET
        for i in range(n + 1):
            for c in ins:
                yield w[:i] + c + w[i:], 0.9 if c in CHEAP_INS else 1.0

    def suggest(self, key: str, limit: int = 5, extra_valid=None) -> list[str]:
        hit = self._sugg.get(key)
        if hit is not None:
            return hit[:limit]
        valid = self.is_valid
        best: dict[str, float] = {}

        def ok(c: str) -> bool:
            return valid(c) or (extra_valid is not None and c in extra_valid)

        for cand, cost in self._edits1(key, False):
            if cand not in best and ok(cand):
                best[cand] = cost
            elif cand in best and cost < best[cand]:
                best[cand] = cost
        if len(best) < 3 and 4 <= len(key) <= 14:
            for e1, c1 in self._edits1(key, True):
                if c1 >= 1.0:
                    continue
                for e2, c2 in self._edits1(e1, True):
                    if e2 != key and e2 not in best and ok(e2):
                        best[e2] = c1 + c2
        if not best:
            for i in range(2, len(key) - 1):
                a, b = key[:i], key[i:]
                if ok(a) and ok(b):
                    best[f"{a} {b}"] = 1.6

        def rank(item: tuple[str, float]):
            cand, cost = item
            if key.startswith("ال") and cand[:2] in ("أل", "إل", "آل"):
                cost += 0.5  # the article's alef never takes a hamza
            f = self.freq.get(cand, 0)
            return (cost, 0 if self.strong_valid(cand) else 1, -math.log1p(f), len(cand))

        out = [c for c, _ in sorted(best.items(), key=rank)[:8]]
        if len(self._sugg) > 20000:
            self._sugg.clear()
        self._sugg[key] = out
        return out[:limit]

    @property
    def info(self) -> dict:
        return {
            "name": "ayaspell Arabic (hunspell-ar)",
            "version": "3.5",
            "license": "GPL-2.0-or-later OR LGPL-2.1-or-later OR MPL-1.1+ (tri-license)",
            "words": self.hs.stem_count,
            "lexicon_words": len(self.lex),
        }


_engine: SpellEngine | None = None
_lock = threading.Lock()


def get_engine() -> SpellEngine:
    global _engine
    if _engine is None:
        with _lock:
            if _engine is None:
                _engine = SpellEngine()
    return _engine


def reset_engine() -> None:
    global _engine
    _engine = None
