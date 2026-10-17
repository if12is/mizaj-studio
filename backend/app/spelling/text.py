"""Text utilities for the spell checker: tokenizing, masking, offsets.

Nothing here rewrites user text; every function returns spans over the ORIGINAL string.
"""

from __future__ import annotations

import re
from bisect import bisect_right
from dataclasses import dataclass

# Arabic word run: letters, tatweel, marks, dagger alef, alef wasla.
AR_WORD_RE = re.compile("[ء-غـ-ْٰٱ]+")
AR_LETTER = "ء-غف-يٱ"
AR_LETTER_RE = re.compile(f"[{AR_LETTER}]")
MARKS_TATWEEL_RE = re.compile("[ـً-ْٰ]")
_LATIN_ADJ = re.compile(r"[A-Za-z0-9_۰-۹٠-٩]")

# Regions never checked: URLs, e-mails, code spans/blocks, file paths, hashtags/mentions.
_MASK_RE = re.compile(
    r"```.*?```|`[^`\n]*`"
    r"|(?:https?://|ftp://|www\.)[^\s<>\"«»]+"
    r"|[\w.+-]+@[\w-]+(?:\.[\w-]+)+"
    r"|(?<![\w])[A-Za-z]:\\[^\s]+"
    r"|[#@][\wء-ي]+",
    re.DOTALL,
)


def strip_for_lookup(word: str) -> str:
    """Lookup key only: drops tashkeel, dagger alef and tatweel. Never used for output."""
    return MARKS_TATWEEL_RE.sub("", word)


def mask_spans(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _MASK_RE.finditer(text)]


class Masker:
    def __init__(self, text: str) -> None:
        self.spans = mask_spans(text)
        self._starts = [s for s, _ in self.spans]

    def covers(self, pos: int) -> bool:
        i = bisect_right(self._starts, pos) - 1
        return i >= 0 and pos < self.spans[i][1]

    def overlaps(self, start: int, end: int) -> bool:
        i = bisect_right(self._starts, end - 1) - 1
        while i >= 0 and self.spans[i][1] > start:
            if self.spans[i][0] < end:
                return True
            i -= 1
        return False


@dataclass(slots=True)
class Token:
    start: int
    end: int
    raw: str  # as written (with marks/tatweel)
    key: str  # marks/tatweel stripped (lookup form)


def tokenize(text: str, masker: Masker) -> list[Token]:
    out: list[Token] = []
    n = len(text)
    for m in AR_WORD_RE.finditer(text):
        s, e = m.span()
        if masker.overlaps(s, e):
            continue
        # glued to Latin letters / digits => not a plain Arabic word (code, ids, model names)
        if (s > 0 and _LATIN_ADJ.match(text[s - 1])) or (e < n and _LATIN_ADJ.match(text[e])):
            continue
        raw = m.group()
        key = strip_for_lookup(raw)
        if not key:
            continue
        out.append(Token(s, e, raw, key))
    return out


class OffsetMap:
    """Code point -> UTF-16 code unit offsets (astral characters count twice)."""

    def __init__(self, text: str) -> None:
        self._astral = [i for i, ch in enumerate(text) if ord(ch) > 0xFFFF]

    def to16(self, pos: int) -> int:
        return pos + bisect_right(self._astral, pos - 1) if self._astral else pos
