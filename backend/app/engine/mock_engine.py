"""Deterministic mock vowelizer (AGENTS.md section 3)."""

from __future__ import annotations

from pyarabic import araby

from app.engine.base import Engine, Lookup
from app.engine.normalize import WORD_RE, has_arabic_letters, strip_marks

FATHA = "َ"
DAMMA = "ُ"
KASRA = "ِ"

MOCK_SUGGESTIONS_ILM = [
    {"diacritized": "عِلْمٌ", "pos": "اسم - مرفوع"},
    {"diacritized": "عَلِمَ", "pos": "فعل ماض"},
    {"diacritized": "عَلَمٌ", "pos": "اسم"},
]


def _mock_word(word: str) -> str:
    """fatha after the first letter, damma after the last (single letter: fatha only)."""
    if len(word) == 1:
        return word + FATHA
    return word[0] + FATHA + word[1:-1] + word[-1] + DAMMA


class MockEngine(Engine):
    name = "mock"
    cache_tag = "mock"

    def vowelize_text(self, text: str, lookup: Lookup | None = None) -> str:
        """Full-text helper: strips tashkeel, cache lookup, rule for uncached Arabic words;
        non-Arabic tokens are untouched."""
        stripped = araby.strip_tashkeel(text)
        found = {}
        if lookup is not None:
            words = sorted({w for w in WORD_RE.findall(stripped) if has_arabic_letters(w)})
            found = lookup(words)

        def fix(m):
            w = m.group(0)
            if not has_arabic_letters(w):
                return w
            cached = found.get(w)
            if cached and strip_marks(cached) == w:
                return cached
            return _mock_word(w)

        return WORD_RE.sub(fix, stripped)

    def diacritize(self, words: list[str], lookup: Lookup | None = None) -> list[str]:
        found = lookup(sorted(set(words))) if lookup is not None else {}
        out = []
        for w in words:
            cached = found.get(w)
            out.append(cached if cached and strip_marks(cached) == w else _mock_word(w))
        return out

    def diacritize_scored(self, words, lookup=None):
        """Deterministic mock confidence: 1.0 for cached/dictionary words, else 0.95 (0.4 for
        3-letter words, which the mock treats as ambiguous)."""
        found = lookup(sorted(set(words))) if lookup is not None else {}
        outs = self.diacritize(words, lookup)
        confs = []
        for w in words:
            hit = bool(found.get(w)) and strip_marks(found[w]) == w
            c = 1.0 if hit else (0.4 if len(w) == 3 else 0.95)
            confs.append((c, c))
        return outs, confs

    def is_ambiguous(self, word: str) -> bool:
        """Mock `minimal` rule: 'ambiguous' iff the bare word has exactly 3 letters."""
        return len(strip_marks(word)) == 3

    def suggestions(self, word: str) -> list[dict[str, str]]:
        w = strip_marks(word)
        if w == "علم":
            return [dict(x) for x in MOCK_SUGGESTIONS_ILM]
        if len(w) == 1:
            return [{"diacritized": w + FATHA, "pos": "اسم - منصوب"}]
        mid = w[1:-1]
        first = w[0] + FATHA
        return [
            {"diacritized": first + mid + w[-1] + DAMMA, "pos": "اسم - مرفوع"},
            {"diacritized": first + mid + w[-1] + KASRA, "pos": "اسم - مجرور"},
            {"diacritized": first + mid + w[-1] + FATHA, "pos": "اسم - منصوب"},
        ]
