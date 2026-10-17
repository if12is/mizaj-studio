"""Conservative context rules for case endings (Task 7.1.6). Off by default.

Only the vowel of the LAST letter is changed (never a base letter), only for definite nouns
(words starting with ال), only when the engine's confidence in that ending is below a threshold,
and only when the analyzer says the word can only be a noun:

* after a preposition (من إلى عن على في حتى منذ مذ رب, or an attached بال/لل/كال)      -> genitive
* after إنّ أنّ كأنّ لكنّ ليت لعلّ                                                         -> accusative
* كان وأخواتها: the first noun after the verb -> nominative, a following definite noun
  (the predicate) -> accusative
"""

from __future__ import annotations

from collections.abc import Callable

from app.engine.normalize import strip_marks

D, F, K = "ُ", "َ", "ِ"
DT, FT, KT = "ٌ", "ً", "ٍ"
_PREPOSITIONS = ("من", "إلى", "عن", "على", "في", "حتى", "منذ", "مذ", "رب")
_ACCUSATIVE_PARTICLES = ("إن", "أن", "لكن", "ليت", "لعل")
_KANA = ("كان", "كانت", "يكون", "تكون", "أصبح", "أصبحت", "أمسى", "بات", "ظل", "ظلت", "صار",
         "صارت", "ليس", "ليست")  # fmt: skip
ATTACHED = ("بال", "لل", "كال")
_TANWEEN_FOR = {"nominative": DT, "accusative": FT, "genitive": KT}
_VOWEL_FOR = {"nominative": D, "accusative": F, "genitive": K}
_CASE_OF = {D: "nominative", DT: "nominative", F: "accusative", FT: "accusative",
            K: "genitive", KT: "genitive"}  # fmt: skip


def _bare(w: str) -> str:
    return strip_marks(w).replace("أ", "ا").replace("إ", "ا")


PREPOSITIONS = {_bare(x) for x in _PREPOSITIONS}
ACCUSATIVE_PARTICLES = {_bare(x) for x in _ACCUSATIVE_PARTICLES}
KANA = {_bare(x) for x in _KANA}


def _is_definite_noun_candidate(w: str) -> bool:
    b = strip_marks(w)
    return b.startswith("ال") and len(b) >= 4 and not b.endswith(("ون", "ان", "هم", "ها", "كم"))


def set_case(pairs: list[tuple[str, str]], case: str) -> list[tuple[str, str]] | None:
    """Return the letter pairs with the last letter's case mark replaced, or None when it cannot
    be done by marks alone (tanween written on a final alef, sound plurals ...)."""
    base, marks = pairs[-1]
    cur = next((c for c in marks if c in _CASE_OF), None)
    if cur is None or _CASE_OF[cur] == case:
        return None
    if cur in (DT, FT, KT):
        if cur == FT and base == "ا":
            return None
        new = _TANWEEN_FOR[case]
    else:
        new = _VOWEL_FOR[case]
    out = list(pairs)
    out[-1] = (base, marks.replace(cur, new))
    return out


def plan(
    words: list[str],
    irab_conf: list[float | None],
    is_noun: Callable[[str], bool] | None,
    threshold: float,
) -> dict[int, str]:
    """word index -> target case. The confidence gate and the noun check are applied here, so
    every returned entry is a change the caller may make. Without an analyzer nothing is done."""
    if is_noun is None:
        return {}
    bares = [_bare(w) for w in words]
    n = len(words)
    targets: dict[int, str] = {}
    for i, b in enumerate(bares):
        if b.startswith(ATTACHED) and len(b) >= 5:
            targets.setdefault(i, "genitive")  # بالمدرسة / للمدرسة / كالمدرسة
        if i + 1 >= n:
            continue
        if b in PREPOSITIONS:
            targets[i + 1] = "genitive"
        elif b in ACCUSATIVE_PARTICLES:
            targets[i + 1] = "accusative"
        elif b in KANA:
            targets[i + 1] = "nominative"
            if i + 2 < n and _is_definite_noun_candidate(words[i + 2]):
                targets.setdefault(i + 2, "accusative")
    out: dict[int, str] = {}
    for j, case in targets.items():
        ic = irab_conf[j] if j < len(irab_conf) else None
        if ic is None or ic >= threshold:
            continue
        definite = _is_definite_noun_candidate(words[j]) or bares[j].startswith(ATTACHED)
        if definite and is_noun(bares[j]):
            out[j] = case
    return out
