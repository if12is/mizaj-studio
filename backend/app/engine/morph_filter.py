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

    def refine(self, bare_words: list[str], catt_out: list[str]) -> list[str]:
        return [self.refine_word(b, c) for b, c in zip(bare_words, catt_out, strict=True)]
