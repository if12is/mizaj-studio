"""Tafqeet: numbers and amounts in Arabic words, fully diacritized from rules (no ML).

Grammar encoded here (see tests/test_phase7_legal.py for the verified table):
* numeral/counted agreement: 1, 2 agree with the counted noun's gender; 3-10 take the OPPOSITE
  gender (ثَلَاثَةُ جُنَيْهَاتٍ, ثَلَاثُ لِيرَاتٍ); 11-19 compound (أَحَدَ عَشَرَ / إِحْدَى عَشْرَةَ,
  fixed on fatha, 12 inflects: اثْنَا/اثْنَيْ); 20-90 sound masculine plurals; units come BEFORE
  tens joined with وَ (وَاحِدٌ وَعِشْرُونَ); hundreds are gender-invariant.
* tamyiz (the counted noun): 3-10 plural genitive, 11-99 singular accusative, 100+ and exact
  thousands/millions singular genitive, 1 -> noun + وَاحِدٌ, 2 -> dual noun.
* dual forms (مِائَتَانِ/مِائَتَيْنِ, أَلْفَانِ/أَلْفَيْنِ) follow the case; in construct (idafa) the
  nun drops (مِائَتَا جُنَيْهٍ, أَلْفَيْ جُنَيْهٍ).
* the last numeral directly before the counted noun is in idafa (no tanween: ثَلَاثَةُ، مِائَةُ،
  أَلْفُ); any numeral followed by وَ keeps tanween.
* 3-10 thousand/million/billion take the plural scale noun (ثَلَاثَةُ آلَافٍ), 11-99 the singular
  accusative (خَمْسَةَ عَشَرَ أَلْفًا), 100/200/... the singular genitive (مِائَةُ أَلْفٍ).
* When the last two digits are 1 or 2 (and the amount is larger than 2) the counted noun is
  placed after the conjunction: أَلْفٌ وَجُنَيْهٌ وَاحِدٌ, مِائَةٌ وَجُنَيْهَانِ.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

from app.engine.normalize import join_pairs, split_pairs, strip_marks

F, D, K, S, SH = "َ", "ُ", "ِ", "ْ", "ّ"
FT, DT, KT = "ً", "ٌ", "ٍ"
NOM, ACC, GEN = "nominative", "accusative", "genitive"
MAX_VALUE = 10**15 - 1  # below one quadrillion
DATA = Path(__file__).resolve().parent / "data" / "currencies.json"


class TafqeetError(ValueError):
    """Invalid amount / currency / option (mapped to ERR_VALIDATION by the API)."""


_CASE_ALIASES = {
    "nominative": NOM, "nom": NOM, "raf": NOM, "مرفوع": NOM, "رفع": NOM,
    "accusative": ACC, "acc": ACC, "nasb": ACC, "منصوب": ACC, "نصب": ACC,
    "genitive": GEN, "gen": GEN, "jarr": GEN, "مجرور": GEN, "جر": GEN,
}  # fmt: skip


def norm_case(case: str | None) -> str:
    key = (case or NOM).strip().lower()
    if key not in _CASE_ALIASES:
        raise TafqeetError(f"unknown case: {case!r}")
    return _CASE_ALIASES[key]


def _vow(case: str) -> str:
    return {NOM: D, ACC: F, GEN: K}[case]


def _tanw(case: str) -> str:
    return {NOM: DT, ACC: FT, GEN: KT}[case]


def indef(stem: str, case: str) -> str:
    """Indefinite (tanween) form; accusative adds the alef unless the stem ends in ة/ا."""
    if case == ACC and not stem.endswith(("ة", "ا")):
        return stem + FT + "ا"
    return stem + _tanw(case)


def construct(stem: str, case: str) -> str:
    return stem + _vow(case)


def _dual(stem: str, case: str, drop_nun: bool = False) -> str:
    base = stem if stem.endswith(F) else stem + F
    if drop_nun:
        return base + ("ا" if case == NOM else "يْ")
    return base + ("انِ" if case == NOM else "يْنِ")


def canon(text: str) -> str:
    """Canonical mark order on every letter (shadda first), for stable output."""
    return join_pairs(split_pairs(text))


# ---------------------------------------------------------------- numerals
UNITS_M = {3: "ثَلَاثَة", 4: "أَرْبَعَة", 5: "خَمْسَة", 6: "سِتَّة", 7: "سَبْعَة", 8: "ثَمَانِيَة",
           9: "تِسْعَة", 10: "عَشَرَة"}  # fmt: skip
UNITS_F = {3: "ثَلَاث", 4: "أَرْبَع", 5: "خَمْس", 6: "سِتّ", 7: "سَبْع", 9: "تِسْع", 10: "عَشْر"}
TENS = {2: "عِشْر", 3: "ثَلَاث", 4: "أَرْبَع", 5: "خَمْس", 6: "سِتّ", 7: "سَبْع", 8: "ثَمَان",
        9: "تِسْع"}  # fmt: skip
HUNDRED_STEM = {3: "ثَلَاث", 4: "أَرْبَع", 5: "خَمْس", 6: "سِتّ", 7: "سَبْع", 9: "تِسْع"}
TEEN_M = {13: "ثَلَاثَةَ", 14: "أَرْبَعَةَ", 15: "خَمْسَةَ", 16: "سِتَّةَ", 17: "سَبْعَةَ",
          18: "ثَمَانِيَةَ", 19: "تِسْعَةَ"}  # fmt: skip
TEEN_F = {13: "ثَلَاثَ", 14: "أَرْبَعَ", 15: "خَمْسَ", 16: "سِتَّ", 17: "سَبْعَ", 18: "ثَمَانِيَ",
          19: "تِسْعَ"}  # fmt: skip

SCALES = [  # (value, singular, dual stem, plural, plural is diptote)
    (10**3, "أَلْف", "أَلْف", "آلَاف", False),
    (10**6, "مِلْيُون", "مِلْيُون", "مَلَايِين", True),
    (10**9, "مِلْيَار", "مِلْيَار", "مِلْيَارَات", False),
    (10**12, "تِرِلْيُون", "تِرِلْيُون", "تِرِلْيُونَات", False),
]


def _mia(spelling: str) -> str:
    return "مِئَة" if spelling == "mi'a" else "مِائَة"


def _unit(n: int, counted: str, case: str, is_construct: bool) -> str:
    """Numeral 1-10 agreeing with a counted noun of gender `counted` ('m'/'f')."""
    if n == 1:
        return indef("وَاحِد" + ("َة" if counted == "f" else ""), case)
    if n == 2:
        return _dual("اثْنَتَ" if counted == "f" else "اثْنَ", case)
    if counted == "m":  # 3-10: feminine-looking (ta marbuta) form for masculine nouns
        stem = UNITS_M[n]
        return construct(stem, case) if is_construct else indef(stem, case)
    if n == 8:  # feminine eight
        if is_construct:
            return "ثَمَانِيَ" if case == ACC else "ثَمَانِي"
        return "ثَمَانِيَ" if case == ACC else "ثَمَانٍ"
    stem = UNITS_F[n]
    return construct(stem, case) if is_construct else indef(stem, case)


def _teen(n: int, counted: str, case: str) -> str:
    fem = counted == "f"
    if n == 11:
        return "إِحْدَى عَشْرَةَ" if fem else "أَحَدَ عَشَرَ"
    if n == 12:
        first = (
            ("اثْنَتَا" if case == NOM else "اثْنَتَيْ") if fem else ("اثْنَا" if case == NOM else "اثْنَيْ")
        )
        return first + (" عَشْرَةَ" if fem else " عَشَرَ")
    return (TEEN_F[n] + " عَشْرَةَ") if fem else (TEEN_M[n] + " عَشَرَ")


def _tens(d: int, case: str) -> str:
    return TENS[d] + ("ُونَ" if case == NOM else "ِينَ")


def _hundred(h: int, case: str, is_construct: bool, spelling: str) -> str:
    mia = _mia(spelling)
    if h == 1:
        return construct(mia, case) if is_construct else indef(mia, case)
    if h == 2:
        stem = "مِئَت" if spelling == "mi'a" else "مِائَت"
        return _dual(stem, case, drop_nun=is_construct)
    if h == 8:
        first = "ثَمَانِ"
    else:
        first = HUNDRED_STEM[h] + _vow(case)
    return first + mia + (K if is_construct else KT)


def _triple(t: int, counted: str, case: str, last_construct: bool, spelling: str) -> list[str]:
    """Words for 1..999 (units before tens, hundreds first)."""
    h, r = divmod(t, 100)
    out: list[str] = []
    if h:
        out.append(_hundred(h, case, last_construct and r == 0, spelling))
    if r:
        if r <= 10:
            out.append(_unit(r, counted, case, is_construct=last_construct and r >= 3))
        elif r < 20:
            out.append(_teen(r, counted, case))
        else:
            tens, u = divmod(r, 10)
            if u:
                out.append(_unit(u, counted, case, is_construct=False))
            out.append(_tens(tens, case))
    return out


def _join(words: list[str]) -> str:
    return " ".join([words[0]] + ["وَ" + w for w in words[1:]]) if words else ""


def _scale_group(t: int, idx: int, case: str, is_construct: bool, spelling: str) -> str:
    _, sing, dual, plural, diptote = SCALES[idx]
    if t == 1:
        return construct(sing, case) if is_construct else indef(sing, case)
    if t == 2:
        return _dual(dual, case, drop_nun=is_construct)
    count = _join(_triple(t, "m", case, True, spelling))
    m = t % 100
    if 3 <= m <= 10:
        if diptote:
            noun = plural + F
        else:
            noun = plural + (K if is_construct else KT)
    elif m >= 11:
        noun = (sing + F) if is_construct else indef(sing, ACC)
    else:  # 0, 1, 2 -> singular genitive
        noun = sing + (K if is_construct else KT)
    return f"{count} {noun}"


def number_words(
    n: int,
    counted: str = "m",
    case: str = NOM,
    *,
    noun_follows: bool = False,
    spelling: str = "ma'a",
) -> str:
    """Words for 0 <= n <= MAX_VALUE. With `noun_follows` the last numeral is in construct
    (idafa) with the counted noun; the caller supplies the noun."""
    if not 0 <= n <= MAX_VALUE:
        raise TafqeetError("number out of range")
    if n == 0:
        return "صِفْر"
    groups: list[tuple[int, int]] = []  # (scale index or -1 for ones, value)
    rest = n
    for idx in range(len(SCALES) - 1, -1, -1):
        base = SCALES[idx][0]
        q, rest = divmod(rest, base)
        if q > 2 and q % 100 in (1, 2):
            # 101 thousand = 100 thousand + "ألف": never "مِائَةٌ وَوَاحِدٌ أَلْفًا"
            groups.append((idx, q - q % 100))
            groups.append((idx, q % 100))
        elif q:
            groups.append((idx, q))
    if rest:
        groups.append((-1, rest))
    parts: list[str] = []
    for i, (idx, t) in enumerate(groups):
        last = i == len(groups) - 1
        if idx == -1:
            parts.append(_join(_triple(t, counted, case, last and noun_follows, spelling)))
        else:
            parts.append(_scale_group(t, idx, case, last and noun_follows, spelling))
    return canon(_join(parts))


# ---------------------------------------------------------------- currencies
@dataclass(frozen=True)
class Unit:
    sing: str
    dual: str
    plural: str
    gender: str
    diptote: bool = False
    invariant: bool = False
    adj: str | None = None


_CUR: dict[str, Any] | None = None


def currencies() -> dict[str, Any]:
    global _CUR
    if _CUR is None:
        _CUR = json.loads(DATA.read_text(encoding="utf-8"))["currencies"]
    return _CUR


def _unit_of(d: dict[str, Any], adj: str | None, invariant: bool = False) -> Unit:
    return Unit(d["sing"], d["dual"], d["plural"], d["gender"], d.get("diptote", False),
                invariant or d.get("invariant", False), adj)  # fmt: skip


def _adj(stem: str, number_class: str, fem: bool, case: str) -> str:
    """Nisba adjective (stem + يّ) agreeing with the counted noun."""
    if number_class == "two":
        base = stem + "ي" + SH + F + ("تَ" if fem else "")
        return _dual(base, case)
    if fem:
        return indef(stem + "ي" + SH + F + "ة", case)
    return indef(stem + "ي" + SH, case)


def _noun_phrase(u: Unit, cls: str, case: str, adjective: bool) -> str:
    """Counted noun (+ nisba adjective, + وَاحِد) for a number class:
    one / two / plural / acc / gen."""
    fem = u.gender == "f"
    use_adj = adjective and u.adj
    if u.invariant:
        noun = u.sing
        if cls == "one":
            return (
                f"{noun} وَاحِدٌ"
                if case == NOM
                else f"{noun} وَاحِدًا"
                if case == ACC
                else f"{noun} وَاحِدٍ"
            )
        return noun
    if cls == "one":
        noun = indef(u.sing, case)
        parts = [noun]
        if use_adj:
            parts.append(_adj(u.adj, "one", fem, case))
        parts.append(indef("وَاحِد" + ("َة" if fem else ""), case))
        return " ".join(parts)
    if cls == "two":
        noun = _dual(u.dual, case)
        return noun + (" " + _adj(u.adj, "two", fem, case) if use_adj else "")
    if cls == "plural":
        noun = (u.plural + F) if u.diptote else indef(u.plural, GEN)
        return noun + (" " + _adj(u.adj, "plural", True, GEN) if use_adj else "")
    if cls == "acc":
        noun = indef(u.sing, ACC)
        return noun + (" " + _adj(u.adj, "acc", fem, ACC) if use_adj else "")
    noun = indef(u.sing, GEN)
    return noun + (" " + _adj(u.adj, "gen", fem, GEN) if use_adj else "")


def counted_phrase(
    n: int, u: Unit, case: str, adjective: bool = False, spelling: str = "ma'a"
) -> str:
    """`n` (> 0) counted units: numeral + counted noun, with all agreement rules."""
    if n <= 0:
        raise TafqeetError("count must be positive")
    if n == 1:
        return _noun_phrase(u, "one", case, adjective)
    if n == 2:
        return _noun_phrase(u, "two", case, adjective)
    r = n % 100
    if r in (1, 2):  # noun after the conjunction: ... وَجُنَيْهٌ وَاحِدٌ
        head = number_words(n - r, u.gender, case, spelling=spelling)
        return f"{head} وَ{_noun_phrase(u, 'one' if r == 1 else 'two', case, adjective)}"
    if n % 1000 == 0 or r == 0:
        cls, follows = "gen", True
    elif 3 <= r <= 10:
        cls, follows = "plural", True
    else:
        cls, follows = "acc", False
    head = number_words(n, u.gender, case, noun_follows=follows, spelling=spelling)
    return f"{head} {_noun_phrase(u, cls, case, adjective)}"


_AR_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩٬٫", "0123456789,.")


def parse_amount(amount: str | int | float | Decimal) -> Decimal:
    if isinstance(amount, float):
        amount = repr(amount)
    s = str(amount).strip().translate(_AR_DIGITS).replace(",", "").replace(" ", "")
    if not re.fullmatch(r"\d+(\.\d+)?", s):
        raise TafqeetError("amount must be a non-negative decimal number")
    try:
        return Decimal(s)
    except InvalidOperation as exc:  # pragma: no cover
        raise TafqeetError("invalid amount") from exc


def amount_words(
    amount: str | int | Decimal,
    currency: str,
    case: str | None = None,
    *,
    adjective: bool = True,
    spelling: str = "ma'a",
    minor: str = "words",
    legal: bool = False,
) -> dict[str, str]:
    """Words for a money amount. Zero, negative and over-precise amounts are rejected (a
    silently rounded amount in a contract is worse than an error)."""
    case_n = norm_case(case)
    cur = currencies().get(currency.upper())
    if cur is None:
        raise TafqeetError(f"unknown currency: {currency}")
    d = parse_amount(amount)
    subs = cur["subunits"]
    total_digits = sum(s["digits"] for s in subs)
    text = format(d, "f")
    whole_s, _, frac_s = text.partition(".")
    frac_s = frac_s.rstrip("0")
    if len(frac_s) > total_digits:
        raise TafqeetError(f"{currency.upper()} supports at most {total_digits} decimal digits")
    frac_s = frac_s.ljust(total_digits, "0")
    whole = int(whole_s)
    if whole > MAX_VALUE:
        raise TafqeetError("amount too large")
    if whole == 0 and not frac_s.strip("0"):
        raise TafqeetError("amount must be greater than zero")
    major = _unit_of(cur, cur.get("adj"))
    phrases: list[str] = []
    if whole:
        phrases.append(counted_phrase(whole, major, case_n, adjective, spelling))
    pos = 0
    for sub in subs:
        digits = frac_s[pos : pos + sub["digits"]]
        pos += sub["digits"]
        value = int(digits)
        if not value:
            continue
        su = _unit_of(sub, None)
        if minor == "fraction":
            phrases.append(f"{value}/{10 ** sub['digits']}")
        else:
            phrases.append(counted_phrase(value, su, case_n, False, spelling))
    words = canon(" وَ".join(phrases))
    formula = canon(f"فَقَطْ {words} لَا غَيْرُ") if legal else words
    return {"words": words, "formula": formula}


# ---------------------------------------------------------------- reverse parse
def _norm(tok: str) -> str:
    t = tok[:-2] if tok.endswith(FT + "ا") else tok  # accusative tanween alef
    t = strip_marks(t)
    for a, b in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ى", "ي"), ("ة", "ه"), ("ـ", "")):
        t = t.replace(a, b)
    return t


_VALUES: dict[str, int] = {}
_SCALE: dict[str, int] = {}
_DUAL_SCALE: dict[str, int] = {}


def _build_vocab() -> None:
    def add(words: str, value: int) -> None:
        for w in words.split():
            _VALUES[_norm(w)] = value

    add("صفر", 0)
    add("واحد واحده احد احدي", 1)
    add("اثنان اثنين اثنا اثني اثنتان اثنتين اثنتا اثنتي", 2)
    add("ثلاثه ثلاث", 3)
    add("اربعه اربع", 4)
    add("خمسه خمس", 5)
    add("سته ست", 6)
    add("سبعه سبع", 7)
    add("ثمانيه ثماني ثمان", 8)
    add("تسعه تسع", 9)
    add("عشره عشر", 10)
    for v, ws in ((20, "عشرون عشرين"), (30, "ثلاثون ثلاثين"), (40, "اربعون اربعين"),
                  (50, "خمسون خمسين"), (60, "ستون ستين"), (70, "سبعون سبعين"),
                  (80, "ثمانون ثمانين"), (90, "تسعون تسعين")):  # fmt: skip
        add(ws, v)
    add("مائه مئه", 100)
    add("مائتان مائتين مائتا مائتي مئتان مئتين مئتا مئتي", 200)
    for stem, v in (("ثلاث", 3), ("اربع", 4), ("خمس", 5), ("ست", 6), ("سبع", 7), ("ثمان", 8),
                    ("ثماني", 8), ("تسع", 9)):  # fmt: skip
        for m in ("مائه", "مئه"):
            _VALUES[_norm(stem + m)] = v * 100
    for value, sing, dual, plural, _d in SCALES:
        _SCALE[_norm(sing)] = value
        _SCALE[_norm(plural)] = value
        for suffix in ("ان", "ين", "ا", "ي"):
            _DUAL_SCALE[_norm(dual + suffix)] = 2 * value
    _SCALE[_norm("بليون")] = 10**9


_build_vocab()
_FILLER = {_norm(w) for w in ("فقط", "لا", "غير", "مبلغ", "وقدره", "قدره", "وقدرها", "قدرها")}


def _conj_stripped(n: str, known) -> str:
    if n in known:
        return n
    if n.startswith("و") and n[1:] in known:
        return n[1:]
    return n


def classify(tok: str) -> tuple[str, int] | None:
    """('value'|'scale'|'dual', number) for a number word token, else None."""
    n = _norm(tok)
    for table, kind in ((_VALUES, "value"), (_SCALE, "scale"), (_DUAL_SCALE, "dual")):
        m = _conj_stripped(n, table)
        if m in table:
            return kind, table[m]
    return None


def is_number_token(tok: str) -> bool:
    return classify(tok) is not None


def words_to_int(tokens: list[str]) -> int | None:
    """Parse number-word tokens (diacritics/hamza-insensitive); None if empty or non-numeric."""
    total = current = prev_unit = 0
    seen = False
    for tok in tokens:
        if _norm(tok) == "و":
            continue
        c = classify(tok)
        if c is None:
            return None
        kind, v = c
        seen = True
        if kind == "dual":
            total += v
            prev_unit = 0
        elif kind == "scale":
            total += (current or 1) * v
            current = prev_unit = 0
        else:
            if v == 100 and 3 <= prev_unit <= 9:
                current += prev_unit * 99  # "ثلاث مائة" written as two words
            else:
                current += v
            prev_unit = v if 3 <= v <= 9 else 0
    return total + current if seen else None
