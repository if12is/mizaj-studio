"""Arabic text helpers built on pyarabic.

Rule: nothing here changes the *visible base text* of what the user wrote. Normalization
(hamza unification, tatweel removal) is used only to build matching keys or engine input,
never for output text.
"""

from __future__ import annotations

import re

from pyarabic import araby

MARKS = "ًٌٍَُِّْ"  # fathatan..sukun incl. shadda
SHADDA = "ّ"
TANWEEN = "ًٌٍ"
TATWEEL = "ـ"
DAGGER = "ٰ"
WASLA = "ٱ"
_MARKS_RE = re.compile(f"[{MARKS}]")
# Arabic "word" run: letters, tatweel, dagger alef, alef wasla and diacritics.
WORD_RE = re.compile("[ء-غـ-ْٰٱ]+")
_LETTER_RE = re.compile("[ء-غف-يٱ]")
_ORDER = {SHADDA: 0}


def strip_marks(text: str) -> str:
    """Remove short-vowel/shadda/sukun/tanween marks (same set as pyarabic strip_tashkeel)."""
    return _MARKS_RE.sub("", text)


def has_arabic_letters(text: str) -> bool:
    return _LETTER_RE.search(text) is not None


def split_pairs(text: str, canon: bool = True) -> list[tuple[str, str]]:
    """Split into (base_char, marks) pairs. Leading orphan marks are dropped."""
    pairs: list[tuple[str, list[str]]] = []
    for ch in text:
        if ch in MARKS:
            if pairs:
                pairs[-1][1].append(ch)
        else:
            pairs.append((ch, []))
    return [(b, canon_marks("".join(m)) if canon else "".join(m)) for b, m in pairs]


def canon_marks(marks: str) -> str:
    """Canonical mark order on one letter: shadda first, then the vowel (dedup)."""
    if len(marks) <= 1:
        return marks
    seen: list[str] = []
    for m in marks:
        if m not in seen:
            seen.append(m)
    return "".join(sorted(seen, key=lambda m: _ORDER.get(m, 1)))


def join_pairs(pairs: list[tuple[str, str]]) -> str:
    return "".join(b + m for b, m in pairs)


def match_key(word: str) -> str:
    """Normalized key for loose matching only (never for output)."""
    return araby.normalize_hamza(araby.strip_tatweel(strip_marks(word)))


def engine_letters(word: str) -> tuple[str, list[int]]:
    """Engine input for an (already stripped) word and the map engine-index -> word-index.

    Tatweel and dagger alef are skipped (the model has no symbols for them); alef wasla
    is fed as plain alef.
    """
    chars: list[str] = []
    idx: list[int] = []
    for i, ch in enumerate(word):
        if ch in (TATWEEL, DAGGER):
            continue
        chars.append("ا" if ch == WASLA else ch)
        idx.append(i)
    return "".join(chars), idx


def marks_for_letters(diacritized: str) -> list[str]:
    return [m for _, m in split_pairs(diacritized)]


def apply_engine_marks(word: str, engine_out: str) -> str | None:
    """Re-attach marks from `engine_out` onto `word` (a stripped original word).

    Returns None if the engine output does not align letter-for-letter.
    """
    eng_in, idx = engine_letters(word)
    pairs = split_pairs(engine_out)
    if len(pairs) != len(eng_in) or "".join(b for b, _ in pairs) != eng_in:
        return None
    marks = {idx[j]: pairs[j][1] for j in range(len(idx))}
    return "".join(ch + marks.get(i, "") for i, ch in enumerate(word))


def last_letter_split(word: str) -> tuple[str, str]:
    """(internal, ending): ending = last letter's vowel marks (shadda stays internal)."""
    pairs = split_pairs(word)
    if not pairs:
        return "", ""
    base, marks = pairs[-1]
    shadda = SHADDA if SHADDA in marks else ""
    ending = marks.replace(SHADDA, "")
    return join_pairs(pairs[:-1]) + base + shadda, ending


def reduce_level(text: str, level: str) -> str:
    """Reduce a fully diacritized text to a lighter level.

    full      : unchanged.
    irab_only : only the marks on the last letter of each word (case ending / tanween).
    minimal   : handled by the pipeline (needs a per-word ambiguity oracle); unchanged here.
    """
    if level not in ("irab_only",):
        return text

    def fix(m: re.Match[str]) -> str:
        pairs = split_pairs(m.group(0))
        out: list[tuple[str, str]] = []
        last = len(pairs) - 1
        for i, (b, marks) in enumerate(pairs):
            # tanween fatha is written on the letter before a final alef (سًا)
            tail_alef = pairs[last][0] == "\u0627" and i == last - 1
            if i == last:
                out.append((b, marks))
            elif tail_alef and "\u064b" in marks:
                out.append((b, "\u064b"))
            else:
                out.append((b, ""))
        return join_pairs(out)

    return WORD_RE.sub(fix, text)
