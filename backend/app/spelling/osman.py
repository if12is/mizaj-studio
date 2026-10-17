"""OSMAN Arabic readability metric - independent Python implementation.

Reference: El-Haj, M. and Rayson, P. (2016), "OSMAN - A Novel Arabic Readability Metric",
LREC 2016, https://aclanthology.org/L16-1038/ ; reference implementation (Java, no licence file,
so NOT copied - this module re-implements the published formula and word/syllable definitions and
is verified against the reference's output on fixtures/osman_reference.json):
https://github.com/drelhaj/OsmanReadability

    OSMAN = 200.791 - 1.015 * (W / S)
                    - 24.18143403 * (complex/W + syllables/W + faseeh/W + long/W)

Definitions as the reference applies them (quirks kept on purpose so scores match exactly):
* W: whitespace-split tokens after deleting ASCII digits and ASCII punctuation (Arabic marks such
  as ، ؟ are kept, so they count towards word length); the empty text counts as 1 word.
* S: pieces of splitting on newlines and on "." not adjacent to a digit, trailing empty pieces
  dropped (so "." alone gives 0, treated as 1 for W/S).
* complex: space-separated pieces holding >= 4 of fatha, damma, kasra, the three tanween, shadda.
* long: tokens (tashkeel removed) of >= 5 UTF-16 units.
* syllables: computed over the WHOLE text: long vowel = fatha/damma/kasra followed by ا و ي,
  short = any other such mark; stress = tanween + shadda; total = 2*long + short + 2*stress.
  If there is no short mark at all, short = (length without ا ى ? . ! , and spaces) - 2, which can
  be negative for tiny inputs (reference behaviour).
* faseeh: space-split words with >= 4 syllables (same rule, per word) containing any of
  ئ ء ؤ ذ ظ.
The reference documents no interpretation bands, so only the raw score is exposed.
"""

from __future__ import annotations

import re

_REMOVE = "ًٌٍَُِّْٓٗ٘"
_TASHKEEL_RE = re.compile(f"[{_REMOVE}]")
_ASCII_PUNCT = re.compile(r"[!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]+")
_SENT_RE = re.compile(r"\n|(?<![0-9])\.(?![0-9])")
_COMPLEX_MARKS = "ًٌٍَُِّ"
FASEEH_CHARS = "ئءؤذظ"
COEF = 24.18143403


def _u16(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def remove_tashkeel(text: str) -> str:
    return _TASHKEEL_RE.sub("", text)


def clean_text(text: str) -> str:
    text = re.sub("[0-9]", "", text)
    text = re.sub("�$", "", text)
    text = _ASCII_PUNCT.sub("", text)
    text = text.replace("�,��`", "")
    text = text.strip("".join(chr(i) for i in range(0x21)))  # Java String.trim()
    return re.sub(" +", " ", text)


def _tokens(text: str) -> list[str]:
    # Java "".split("\\s+") -> [""]; trailing empty strings are dropped, leading ones kept
    parts = re.split(r"\s+", clean_text(text))
    while len(parts) > 1 and parts[-1] == "":
        parts.pop()
    return parts


def count_words(text: str) -> int:
    return len(_tokens(text))


def count_sentences(text: str) -> int:
    if not _SENT_RE.search(text):
        return 1
    parts = _SENT_RE.split(text)
    while parts and parts[-1] == "":
        parts.pop()
    return len(parts)


def count_complex(text: str) -> int:
    return sum(1 for w in text.split(" ") if sum(w.count(c) for c in _COMPLEX_MARKS) >= 4)


def count_long(text: str) -> int:
    return sum(1 for w in _tokens(remove_tashkeel(text)) if _u16(w) >= 5)


def _syllable_parts(word: str) -> tuple[int, int, int]:
    long_ = short = 0
    n = len(word)
    for i, ch in enumerate(word):
        if ch in "َُِ":
            if i + 1 < n and word[i + 1] in "اوي":
                long_ += 1
            else:
                short += 1
    stress = sum(word.count(c) for c in "ًٌٍّ")
    if short == 0:
        w = word
        for c in ("ا", "ى", "?", ".", "!", ",", " "):
            w = w.replace(c, "")
        short = _u16(w) - 2
    return short, long_, stress


def count_syllables(text: str) -> int:
    short, long_, stress = _syllable_parts(text)
    return long_ * 2 + short + stress * 2


def count_faseeh(text: str) -> int:
    n = 0
    parts = text.strip("".join(chr(i) for i in range(0x21))).split(" ")
    while len(parts) > 1 and parts[-1] == "":
        parts.pop()
    for w in parts:
        if count_syllables(w) >= 4 and any(c in w for c in FASEEH_CHARS):
            n += 1
    return n


def osman(text: str) -> dict:
    """Score and every component (counts as the reference computes them)."""
    words = count_words(text)
    sents = count_sentences(text)
    cx, sy, fa, lg = (
        count_complex(text),
        count_syllables(text),
        count_faseeh(text),
        count_long(text),
    )
    wps = words / (sents if sents else 1)
    score = 200.791 - 1.015 * wps - COEF * (cx / words + sy / words + fa / words + lg / words)
    return {
        "score": score,
        "words": words,
        "sentences": sents,
        "complex": cx,
        "syllables": sy,
        "faseeh": fa,
        "long": lg,
    }
