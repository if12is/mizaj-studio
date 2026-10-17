"""Prosodic writing ('taqti3' pattern): fully diacritized Arabic -> string of 1 (mutaharrik,
moving) and 0 (sakin).

Rules implemented (the standard ones for classical verse):
* a letter with fatha/damma/kasra -> 1; sukun -> 0; shadda -> "01" (sukun + moving letter);
* tanween -> the moving letter + a silent-in-writing nun: "10"; an alef written after fathatan is
  silent and dropped;
* madd letters (unmarked alef after fatha, waw after damma, ya/alef-maqsura after kasra) -> 0;
  an unmarked alef not after a fatha (alef of waw al-jama'a, hamzat wasl inside a word) is silent;
* hamzat wasl of "ال" and of verbs/nouns beginning with an unmarked alef is dropped when the
  previous word ends in a vowel, and counted 1 at the start of a hemistich; the lam of "ال" before
  a sun letter (the next letter carries shadda) is silent;
* a trailing '1' at the end of a hemistich may also be a lengthened vowel (ishba'), handled by
  the matcher.
Unmarked consonants make the pattern unreliable: they are reported in `missing`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.engine.normalize import SHADDA, WORD_RE, split_pairs

ALEF, WAW, YA, MAKSURA, LAM, ALEF_WASLA = "ا", "و", "ي", "ى", "ل", "ٱ"
FATHA, DAMMA, KASRA, SUKUN = "َ", "ُ", "ِ", "ْ"
FATHATAN, DAMMATAN, KASRATAN = "ً", "ٌ", "ٍ"
VOWELS = {FATHA, DAMMA, KASRA}
TANWEEN = {FATHATAN, DAMMATAN, KASRATAN}
LETTER_RANGE = ("ء", "ي")


@dataclass
class Prosody:
    pattern: str
    missing: list[int] = field(default_factory=list)  # character offsets of unmarked consonants


def _is_letter(ch: str) -> bool:
    return LETTER_RANGE[0] <= ch <= LETTER_RANGE[1] or ch == ALEF_WASLA


def hemistich_pattern(text: str) -> Prosody:
    out: list[str] = []
    missing: list[int] = []
    first_word = True
    for m in WORD_RE.finditer(text):
        pairs = [(b, mk) for b, mk in split_pairs(m.group(0)) if _is_letter(b)]
        if not pairs:
            continue
        prev_ends_vowel = bool(out) and out[-1] == "1"
        i = 0
        # alef of ال / hamzat wasl
        if pairs[0][0] in (ALEF, ALEF_WASLA) and not pairs[0][1] and len(pairs) > 1:
            is_al = len(pairs) > 2 and pairs[1][0] == LAM
            if is_al or pairs[1][0] != ALEF:
                if first_word or not prev_ends_vowel:
                    out.append("1")  # pronounced with a helping vowel
                i = 1
                if is_al and pairs[2][1].startswith(SHADDA) or (is_al and SHADDA in pairs[2][1]):
                    i = 2  # sun letter: the lam is silent
        prev_vowel = ""
        while i < len(pairs):
            base, marks = pairs[i]
            vowel = next((c for c in marks if c in VOWELS | TANWEEN | {SUKUN}), "")
            shadda = SHADDA in marks
            madd_base = base in (ALEF, WAW, YA, MAKSURA)
            if not marks and madd_base:
                if base in (ALEF, MAKSURA) and prev_vowel == FATHA:
                    out.append("0")
                elif base == WAW and prev_vowel == DAMMA:
                    out.append("0")
                elif base in (YA, MAKSURA) and prev_vowel == KASRA:
                    out.append("0")
                elif base == ALEF:
                    pass  # silent alef (waw al-jama'a, after tanween ...)
                else:
                    out.append("0")  # consonantal waw/ya without a vowel: treated as sakin
                prev_vowel = ""
                i += 1
                continue
            if not marks:
                missing.append(m.start() + i)
                out.append("1")
                prev_vowel = ""
                i += 1
                continue
            if shadda:
                out.append("0")
                out.append("1" if vowel not in ("", SUKUN) else "0")
            elif vowel in VOWELS:
                out.append("1")
            elif vowel in TANWEEN:
                out.append("10")
            else:
                out.append("0")
            prev_vowel = vowel
            i += 1
        first_word = False
    return Prosody("".join(out), missing)
