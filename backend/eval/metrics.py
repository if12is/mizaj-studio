"""DER / WER for Arabic diacritization.

Conventions (document of record for the numbers in RESULTS.md):

* Only Arabic *letters* (U+0621-063A, U+0641-064A) are counted. Digits, punctuation, Latin text,
  tatweel and dagger alef are ignored. Gold and prediction must have the same undiacritized text
  (the pipeline guarantees it); a pair that does not align is skipped and counted in `skipped`.
* A letter's diacritic is its canonical mark string (shadda first, then the vowel/tanween/sukun).
  Tanween fatha written on a final alef (`ا` + U+064B) is moved to the previous letter, so both
  spellings compare equal.
* "with case ending" counts every letter; "without case ending" excludes the LAST letter of each
  word (its marks - the i'rab - are ignored). Words with a single letter then have nothing to
  compare and are left out of the WER denominator.
* Two scopes (Fadel et al., 2019 report both):
    - `all`        : every counted letter, a letter with no diacritic in gold must also have none
                     in the prediction (so over-diacritization is an error);
    - `gold_only`  : only letters that carry a diacritic in the gold text ("no diacritic" positions
                     excluded).
* DER = wrong letters / counted letters. WER = words with >= 1 wrong counted letter / counted words.
* Breakdown (reported for "with case ending"): `internal_der` (non-final letters, vowel part),
  `final_der` (last letters, vowel part = i'rab), `shadda_error` (shadda present/absent mismatches
  divided by the number of gold shadda letters).
"""

from __future__ import annotations

from typing import Any

from app.engine.normalize import SHADDA, WORD_RE, split_pairs

LETTERS = frozenset(chr(c) for c in range(0x0621, 0x063B)) | frozenset(
    chr(c) for c in range(0x0641, 0x064B)
)
ALEF = "ا"
FATHATAN = "ً"

Word = list[tuple[str, str]]  # [(letter, marks)]


def words(text: str) -> list[Word]:
    """Arabic words as lists of (letter, canonical marks); non-letters are dropped."""
    out: list[Word] = []
    for m in WORD_RE.finditer(text):
        letters: Word = [(b, mk) for b, mk in split_pairs(m.group(0)) if b in LETTERS]
        if not letters:
            continue
        # tanween fatha on a final alef -> previous letter
        if len(letters) > 1 and letters[-1][0] == ALEF and FATHATAN in letters[-1][1]:
            b, mk = letters[-2]
            letters[-2] = (b, mk if FATHATAN in mk else _join(mk, FATHATAN))
            letters[-1] = (ALEF, letters[-1][1].replace(FATHATAN, ""))
        out.append(letters)
    return out


def _join(marks: str, extra: str) -> str:
    return "".join(sorted(set(marks + extra), key=lambda c: 0 if c == SHADDA else 1))


def _vowel(marks: str) -> str:
    return marks.replace(SHADDA, "")


class _Acc:
    def __init__(self) -> None:
        self.letters = self.errors = self.words = self.word_errors = 0
        self.int_n = self.int_e = self.fin_n = self.fin_e = 0
        self.shadda_gold = self.shadda_err = 0


def compute(golds: list[str], preds: list[str]) -> dict[str, Any]:
    """Metrics for aligned lists of gold / predicted texts."""
    assert len(golds) == len(preds)
    acc = {(c, s): _Acc() for c in ("with", "without") for s in ("all", "gold_only")}
    skipped = 0
    for g_text, p_text in zip(golds, preds, strict=True):
        gw, pw = words(g_text), words(p_text)
        if len(gw) != len(pw) or any(
            [b for b, _ in a] != [b for b, _ in c] for a, c in zip(gw, pw, strict=True)
        ):
            skipped += 1
            continue
        for g, p in zip(gw, pw, strict=True):
            n = len(g)
            for case in ("with", "without"):
                for scope in ("all", "gold_only"):
                    a = acc[(case, scope)]
                    counted = wrong = 0
                    for i in range(n):
                        final = i == n - 1
                        if case == "without" and final:
                            continue
                        gm, pm = g[i][1], p[i][1]
                        if scope == "gold_only" and not gm:
                            continue
                        counted += 1
                        bad = gm != pm
                        wrong += bad
                        if case == "with":
                            if final:
                                a.fin_n += 1
                                a.fin_e += _vowel(gm) != _vowel(pm)
                            else:
                                a.int_n += 1
                                a.int_e += _vowel(gm) != _vowel(pm)
                    a.letters += counted
                    a.errors += wrong
                    if counted:
                        a.words += 1
                        a.word_errors += wrong > 0
            a = acc[("with", "all")]
            for (_, gm), (_, pm) in zip(g, p, strict=True):
                if SHADDA in gm:
                    a.shadda_gold += 1
                if (SHADDA in gm) != (SHADDA in pm):
                    a.shadda_err += 1

    def pct(x: int, n: int) -> float | None:
        return round(100.0 * x / n, 3) if n else None

    out: dict[str, Any] = {"unaligned_sentences": skipped}
    for case in ("with", "without"):
        key = f"{case}_case_ending"
        out[key] = {}
        for scope in ("all", "gold_only"):
            a = acc[(case, scope)]
            d = {
                "der": pct(a.errors, a.letters),
                "wer": pct(a.word_errors, a.words),
                "letters": a.letters,
                "letter_errors": a.errors,
                "words": a.words,
                "word_errors": a.word_errors,
            }
            if case == "with":
                shadda = acc[("with", "all")]
                d.update(
                    internal_der=pct(a.int_e, a.int_n),
                    final_der=pct(a.fin_e, a.fin_n),
                    shadda_error=pct(shadda.shadda_err, shadda.shadda_gold),
                )
            out[key][scope] = d
    return out
