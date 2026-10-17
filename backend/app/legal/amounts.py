"""Amount consistency checker: a number next to its words in parentheses (either order)."""

from __future__ import annotations

import re
from typing import Any

from app.legal.tafqeet import (
    TafqeetError,
    _norm,
    currencies,
    is_number_token,
    number_words,
    words_to_int,
)

_AR = str.maketrans("٠١٢٣٤٥٦٧٨٩٬٫", "0123456789,.")
NUM = r"\d[\d,٬]*(?:[.٫]\d+)?|[٠-٩][٠-٩٬]*(?:٫[٠-٩]+)?"
_PAREN = re.compile(r"\(([^()\n]{1,240})\)|（([^（）\n]{1,240})）")
_TOKEN = re.compile(r"[ء-يٰٱً-ْ]+")
_FILLER = {_norm(w) for w in ("فقط", "لا", "غير", "مبلغ", "وقدره", "قدره", "وقدرها", "قدرها", "و")}


_DUALS: set[str] = set()


def _noun_forms() -> dict[str, str]:
    """normalized currency noun -> 'major' | 'minor' (dual forms are also recorded in _DUALS)."""
    out: dict[str, str] = {}
    for cur in currencies().values():
        for kind, unit in [("major", cur)] + [("minor", s) for s in cur["subunits"]]:
            for key in ("sing", "plural"):
                out[_norm(unit[key])] = kind
            for suffix in ("ان", "ين"):
                out[_norm(unit["dual"]) + suffix] = kind
                _DUALS.add(_norm(unit["dual"]) + suffix)
    return out


_NOUNS: dict[str, str] | None = None


def _nouns() -> dict[str, str]:
    global _NOUNS
    if _NOUNS is None:
        _NOUNS = _noun_forms()
    return _NOUNS


def _parse_number(lit: str) -> tuple[int, str] | None:
    s = lit.translate(_AR).replace(",", "")
    m = re.fullmatch(r"(\d+)(?:\.(\d+))?", s)
    return (int(m.group(1)), m.group(2) or "") if m else None


def _parse_words(text: str) -> tuple[int, int | None] | None:
    """(major, minor|None) for number words (+ currency nouns) in `text`; None if no number."""
    toks = _TOKEN.findall(text)
    nouns = _nouns()
    major: list[str] = []
    minor: list[str] = []
    cur = major
    extra = 0
    i = 0
    while i < len(toks):
        n = _norm(toks[i])
        if n in _FILLER:
            i += 1
            continue
        if is_number_token(toks[i]):
            cur.append(toks[i])
        else:
            bare = n[1:] if n.startswith("و") and n[1:] in nouns else n
            kind = nouns.get(bare)
            if kind is None:
                if cur:
                    break  # prose after the amount
                i += 1
                continue
            inline = n.startswith("و") and bare != n
            if inline and cur is major and major:  # "... وجنيه واحد" / "... وجنيهان"
                if bare in _DUALS:
                    extra += 2
                elif i + 1 < len(toks) and _norm(toks[i + 1]) in ("واحد", "واحده"):
                    extra += 1
                    i += 1
                i += 1
                continue
            if not major and cur is major and not inline:
                if bare in _DUALS:  # noun-first dual: "جنيهان"
                    extra += 2
                i += 1
                continue
            if kind == "major" and cur is major:
                cur = minor
            elif kind == "minor" and cur is major:
                cur = minor  # amount in minor units only
        i += 1
    if not major and not minor:
        return None
    mv = words_to_int(major) if major else 0
    if mv is None:
        return None
    mv += extra
    nv = words_to_int(minor) if minor else None
    return mv, nv


def _expected_frac(frac: str) -> list[int]:
    if not frac:
        return [0]
    opts = {int(frac.ljust(2, "0")[:2]) if len(frac) <= 2 else int(frac.ljust(3, "0"))}
    if len(frac) <= 2:
        opts.add(int(frac.ljust(3, "0")))
    return sorted(opts)


def _issue(kind: str, start: int, end: int, text: str, **extra: Any) -> dict[str, Any]:
    msg_ar = {
        "mismatch": "تعارض بين المبلغ بالأرقام وبالحروف.",
        "unparsed": "تعذر فهم المبلغ المكتوب بالحروف؛ راجعه يدوياً.",
    }[kind]
    msg_en = {
        "mismatch": "The amount in figures and in words do not match.",
        "unparsed": "Could not read the amount in words; please review it manually.",
    }[kind]
    return {"kind": kind, "start": start, "end": end, "text": text, "message_ar": msg_ar,
            "message_en": msg_en, **extra}  # fmt: skip


def check_amounts(text: str) -> list[dict[str, Any]]:
    """Flag `1,500 (ألف وخمسمائة وخمسون)` / `ألف وخمسمائة (1,550)` style contradictions."""
    issues: list[dict[str, Any]] = []
    for m in _PAREN.finditer(text):
        inside = (m.group(1) or m.group(2)).strip()
        before = text[: m.start()]
        # (A) figures before, words in parentheses
        lit_in = re.fullmatch(NUM, inside)
        if lit_in is None:
            fm = re.search(rf"({NUM})\s*((?:[ء-يً-ْ]+\s*){{0,3}})$", before)
            if not fm:
                continue
            num, words_part = fm.group(1), inside
            span_start = fm.start(1)
        else:
            # (B) words before, figures in parentheses
            toks = list(_TOKEN.finditer(before))
            k = len(toks)
            while k > 0:
                n = _norm(toks[k - 1].group(0))
                if (
                    is_number_token(toks[k - 1].group(0))
                    or n in _FILLER
                    or n in _nouns()
                    or (n.startswith("و") and n[1:] in _nouns())
                ):
                    k -= 1
                else:
                    break
            if k == len(toks):
                continue
            span_start = toks[k].start()
            words_part = before[span_start:]
            num = inside
        parsed_num = _parse_number(num)
        parsed_words = _parse_words(words_part)
        end = m.end()
        if parsed_num is None:
            continue
        if parsed_words is None:
            if lit_in is None and any(is_number_token(t) for t in _TOKEN.findall(inside)):
                issues.append(_issue("unparsed", span_start, end, text[span_start:end]))
            continue
        whole, frac = parsed_num
        mv, nv = parsed_words
        ok = whole == mv
        if ok and (frac.strip("0") or nv):
            ok = nv is not None and nv in _expected_frac(frac)
        if not ok:
            try:
                expected = number_words(whole)
            except TafqeetError:
                expected = ""
            issues.append(
                _issue(
                    "mismatch", span_start, end, text[span_start:end],
                    number=num, number_value=whole, words_value=mv, expected_words=expected,
                )
            )  # fmt: skip
    return issues
