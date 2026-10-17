"""Orchestration of the three spelling checks over one text (pure functions, no I/O)."""

from __future__ import annotations

import re
import time

from .engine import SpellEngine
from .patterns import check_patterns
from .punct import check_punctuation
from .text import Masker, OffsetMap, Token, tokenize

ALL_CHECKS = ("dictionary", "patterns", "punctuation")
MAX_SUGGEST_WORDS = 80  # more are fetched on demand via /suggest
SUGGEST_BUDGET_S = 1.5
_EMPHASIS = re.compile(r"(.)\1\1")
_OTHER_SCRIPT_ADJ = re.compile("[؀-ؠػ-ؿٓ-ۿݐ-ࣿﭐ-ﻼ]")

MSG_UNKNOWN = "الكلمة غير موجودة في القاموس الإملائي."
MSG_UNKNOWN_NAME = "الكلمة غير موجودة في القاموس (قد تكون اسماً أو مصطلحاً)."


def _dictionary_issues(
    text: str, tokens: list[Token], eng: SpellEngine, known: set[str], ignored: set[str]
) -> list[dict]:
    out: list[dict] = []
    n = len(text)
    suggest_budget = MAX_SUGGEST_WORDS
    deadline = time.perf_counter() + SUGGEST_BUDGET_S
    cache: dict[str, bool] = {}
    for t in tokens:
        k = t.key
        if len(k) < 2 or k in ignored or k in known:
            continue
        ok = cache.get(k)
        if ok is None:
            ok = eng.is_valid(k)
            cache[k] = ok
        if ok:
            continue
        if _EMPHASIS.search(k):  # هههه / جدااااا : deliberate lengthening
            continue
        if (t.start > 0 and _OTHER_SCRIPT_ADJ.match(text[t.start - 1])) or (
            t.end < n and _OTHER_SCRIPT_ADJ.match(text[t.end])
        ):
            continue
        sugg: list[str] = []
        if k in eng._sugg or (suggest_budget > 0 and time.perf_counter() < deadline):
            if k not in eng._sugg:
                suggest_budget -= 1
            sugg = eng.suggest(k, 5, extra_valid=known)
        out.append(
            {
                "start": t.start,
                "end": t.end,
                "word": t.raw,
                "code": "SPELL_UNKNOWN",
                "category": "spelling",
                "severity": "warning" if sugg else "info",
                "message_ar": MSG_UNKNOWN if sugg else MSG_UNKNOWN_NAME,
                "suggestions": sugg,
                "confidence": 0.8 if sugg else 0.4,
            }
        )
    return out


def _merge(issues: list[dict]) -> list[dict]:
    """A pattern issue explains (and replaces) dictionary issues on the same span."""
    pats = [i for i in issues if i["category"] == "pattern"]
    out: list[dict] = []
    for i in issues:
        if i["category"] == "spelling":
            hit = next((p for p in pats if p["start"] < i["end"] and i["start"] < p["end"]), None)
            if hit is not None:
                if (hit["start"], hit["end"]) == (i["start"], i["end"]) and hit["confidence"] < 0.8:
                    for s in i["suggestions"]:
                        if s not in hit["suggestions"] and len(hit["suggestions"]) < 5:
                            hit["suggestions"].append(s)
                continue
        out.append(i)
    return out


def check_text(
    text: str,
    eng: SpellEngine,
    checks: tuple[str, ...] = ALL_CHECKS,
    max_issues: int = 1000,
    known: set[str] | None = None,
    ignored: set[str] | None = None,
) -> dict:
    t0 = time.perf_counter()
    known = known or set()
    ignored = ignored or set()
    masker = Masker(text)
    tokens = tokenize(text, masker)
    issues: list[dict] = []
    if "patterns" in checks:
        issues += check_patterns(text, tokens, eng, known, ignored)
    if "dictionary" in checks:
        issues += _dictionary_issues(text, tokens, eng, known, ignored)
    if "punctuation" in checks:
        issues += check_punctuation(text, masker)
    issues = _merge(issues)
    issues.sort(key=lambda i: (i["start"], i["end"], i["code"]))
    # drop exact duplicates
    seen: set[tuple[int, int, str]] = set()
    uniq = []
    for i in issues:
        key = (i["start"], i["end"], i["code"])
        if key not in seen:
            seen.add(key)
            uniq.append(i)
    truncated = len(uniq) > max_issues
    uniq = uniq[:max_issues]
    om = OffsetMap(text)
    for i in uniq:
        i["start16"] = om.to16(i["start"])
        i["end16"] = om.to16(i["end"])
    return {
        "issues": uniq,
        "stats": {
            "words": len(tokens),
            "unique": len({t.key for t in tokens}),
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
            "truncated": truncated,
        },
    }
