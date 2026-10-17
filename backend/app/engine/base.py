from __future__ import annotations

from collections.abc import Callable

# lookup(words) -> {word: diacritized_form}
Lookup = Callable[[list[str]], dict[str, str]]


class Engine:
    name = "engine"
    cache_tag = "engine"

    def diacritize(self, words: list[str], lookup: Lookup | None = None) -> list[str]:
        """Diacritize `words` (Arabic letters only, in sentence order); same length out."""
        raise NotImplementedError

    def diacritize_scored(
        self, words: list[str], lookup: Lookup | None = None
    ) -> tuple[list[str], list[tuple[float, float] | None]]:
        """Like `diacritize` plus, per word, (word_confidence, irab_confidence) in [0, 1] or
        None when the engine cannot tell. Confidence = how sure the engine is of its marks."""
        outs = self.diacritize(words, lookup)
        return outs, [None] * len(outs)

    def suggestions(self, word: str) -> list[dict[str, str]]:
        raise NotImplementedError

    def is_ambiguous(self, word: str) -> bool:
        """True if the bare word has more than one common vocalization (used by `minimal`)."""
        raise NotImplementedError
