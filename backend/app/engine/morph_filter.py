"""Morphological sanity filter for CATT output (mishkal / qalsadi).

Rule (deliberately conservative). For each word with CATT diacritization `c`:
  1. Ask qalsadi for all vocalizations of the bare word and split each into
     (internal, ending) where `ending` is the last letter's vowel mark (the case ending,
     which depends on syntax that CATT sees in context but isolated analysis cannot).
  2. If `c` itself is among the candidates, keep it.
  3. Otherwise, if mishkal is *confident* -- all candidates share exactly one distinct
     `internal` form and the word has at least 3 letters -- replace only the internal
     vowels with that form and KEEP CATT's own ending.
  4. In every other case (no candidates, ambiguous internal forms) keep CATT's output.
Toggle: `MIZAJ_MORPH_FILTER=0` or the request field `morph_filter=false`.
"""

from __future__ import annotations

from app.engine.mishkal_engine import MishkalEngine
from app.engine.normalize import join_pairs, last_letter_split, split_pairs, strip_marks


def _canon(word: str) -> str:
    return join_pairs(split_pairs(word))


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
        c = _canon(catt_form)
        if c in cands:
            return catt_form
        internals = {last_letter_split(v)[0] for v in cands}
        if len(internals) != 1:
            return catt_form
        internal = next(iter(internals))
        ending = last_letter_split(c)[1]
        # internal already carries the last base letter (+shadda); append CATT's ending
        fixed = internal + ending
        if strip_marks(fixed) != bare:
            return catt_form
        if fixed != c:
            self.replaced += 1
        return fixed

    def refine(self, bare_words: list[str], catt_out: list[str]) -> list[str]:
        return [self.refine_word(b, c) for b, c in zip(bare_words, catt_out, strict=True)]
