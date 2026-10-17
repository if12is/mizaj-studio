"""Morphological sanity filter for CATT output (mishkal / qalsadi).

Rule (deliberately conservative -- it can only *correct a conflicting vowel*, never remove or
add diacritics). For each word with CATT diacritization `c`:
  1. Ask qalsadi for all vocalizations of the bare word. If `c` is itself one of them, keep it.
  2. Compute, for every candidate, its *internal vowel pattern*: the vowel of each letter
     except the last (the last letter's vowel is the case ending, which depends on syntax
     that CATT sees in context but isolated analysis cannot). Shadda is ignored here.
  3. mishkal is *confident* only if the word has >= 3 letters and all candidates share exactly
     one internal vowel pattern. Otherwise keep `c`.
  4. When confident, on each internal letter where BOTH CATT and mishkal carry a vowel and
     they differ, take mishkal's vowel (keeping CATT's shadda). Letters where either side has
     no mark are left as CATT wrote them (mishkal omits long-vowel marks CATT adds), and
     CATT's case ending is always kept.
Toggle: `MIZAJ_MORPH_FILTER=0` or the request field `morph_filter=false`.
"""

from __future__ import annotations

from app.engine.mishkal_engine import MishkalEngine
from app.engine.normalize import SHADDA, join_pairs, split_pairs, strip_marks


def _canon(word: str) -> str:
    return join_pairs(split_pairs(word))


def _vowel(marks: str) -> str:
    return marks.replace(SHADDA, "")


class MorphFilter:
    version = 1

    def __init__(self, analyzer: MishkalEngine) -> None:
        self.analyzer = analyzer
        self.replaced = 0

    def refine_word(self, bare: str, catt_form: str) -> str:
        if len(bare) < 3:
            return catt_form
        cands = {_canon(v) for v, _, _ in self.analyzer.candidates(bare)}
        if not cands:
            return catt_form
        c_pairs = split_pairs(catt_form)
        if join_pairs(c_pairs) in cands or len(c_pairs) != len(bare):
            return catt_form
        patterns = set()
        for v in cands:
            p = split_pairs(v)
            if len(p) != len(bare):
                return catt_form
            patterns.add(tuple(_vowel(m) for _, m in p[:-1]))
        if len(patterns) != 1:
            return catt_form
        ref = next(iter(patterns))
        out = list(c_pairs)
        changed = False
        for i, want in enumerate(ref):
            base, marks = out[i]
            have = _vowel(marks)
            if want and have and want != have:
                shadda = SHADDA if SHADDA in marks else ""
                out[i] = (base, shadda + want)
                changed = True
        if not changed:
            return catt_form
        fixed = join_pairs(out)
        if strip_marks(fixed) != bare:
            return catt_form
        self.replaced += 1
        return fixed

    def refine(self, bare_words: list[str], catt_out: list[str], confs=None) -> list[str]:
        return [self.refine_word(b, c) for b, c in zip(bare_words, catt_out, strict=True)]


class MorphFilterV2:
    version = 2

    """Confidence-gated re-ranking (Task 7.1.4, v2).

    For words the engine is NOT sure about (word confidence < `threshold`) whose vocalization is
    not a qalsadi analysis: pick the analysis whose internal vowel pattern is closest to the
    engine's (edit distance over the vowel sequence, ties -> most frequent) and copy only the
    vowels where BOTH sides carry one and they differ. Never adds/removes marks, never touches
    the case ending, never changes a base letter."""

    def __init__(self, analyzer, threshold: float = 0.9) -> None:
        self.analyzer = analyzer
        self.threshold = threshold
        self.replaced = 0

    @staticmethod
    def _pattern(pairs) -> tuple[str, ...]:
        return tuple(_vowel(m) for _, m in pairs[:-1])

    @staticmethod
    def _dist(a: tuple[str, ...], b: tuple[str, ...]) -> int:
        return sum(1 for x, y in zip(a, b, strict=True) if x and y and x != y)

    def refine_word(self, bare: str, catt_form: str, conf: float | None) -> str:
        if len(bare) < 3 or conf is None or conf >= self.threshold:
            return catt_form
        cands = self.analyzer.candidates(bare)
        if not cands:
            return catt_form
        c_pairs = split_pairs(catt_form)
        if len(c_pairs) != len(bare) or join_pairs(c_pairs) in {_canon(v) for v, _, _ in cands}:
            return catt_form
        mine = self._pattern(c_pairs)
        best = None
        for voc, _, _freq in sorted(cands, key=lambda c: -c[2]):
            p = split_pairs(voc)
            if len(p) != len(bare):
                continue
            pat = self._pattern(p)
            d = self._dist(mine, pat)
            if best is None or d < best[0]:
                best = (d, pat)
        if best is None or best[0] == 0 or best[0] > 1:
            return catt_form  # no candidate to prefer, or too far to trust
        out = list(c_pairs)
        for i, want in enumerate(best[1]):
            base, marks = out[i]
            have = _vowel(marks)
            if want and have and want != have:
                out[i] = (base, (SHADDA if SHADDA in marks else "") + want)
        fixed = join_pairs(out)
        if strip_marks(fixed) != bare:
            return catt_form
        self.replaced += 1
        return fixed

    def refine(self, bare_words, outs, confs=None):
        confs = confs or [None] * len(outs)
        return [
            self.refine_word(b, c, (cf[0] if cf else None))
            for b, c, cf in zip(bare_words, outs, confs, strict=True)
        ]
