"""'Arud (prosody): meter detection for classical Arabic verse (Task 7.4.2, detection only)."""

from __future__ import annotations

import re
from typing import Any

from app.arud.meters import LIMITS, METERS, best_partial, hemistich_patterns, match
from app.arud.prosody import hemistich_pattern

SEPARATORS = re.compile(r"\s*(?:\*{2,}|…|\.{3,}|\s{3,}|\t|\s[-–—]\s)\s*")


def split_verses(text: str) -> list[list[str]]:
    """Lines -> verses -> hemistichs. A line with a separator (***, ..., a tab, 3+ spaces) is one
    two-hemistich verse; otherwise consecutive lines pair up as (sadr, ajuz)."""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    verses: list[list[str]] = []
    pending: list[str] = []
    for ln in lines:
        parts = [p for p in SEPARATORS.split(ln) if p.strip()]
        if len(parts) >= 2:
            if pending:
                verses.append(pending)
                pending = []
            verses.append(parts[:2])
        else:
            pending.append(ln)
            if len(pending) == 2:
                verses.append(pending)
                pending = []
    if pending:
        verses.append(pending)
    return verses


def analyze(text: str) -> dict[str, Any]:
    """Detect the meter of diacritized verse. Returns per-hemistich patterns/matches and the
    overall best meter (most hemistichs matched)."""
    verses = split_verses(text)
    out_verses = []
    votes: dict[str, int] = {}
    costs: dict[str, int] = {}
    total = 0
    for v in verses:
        hs = []
        for h in v:
            pr = hemistich_pattern(h)
            total += 1
            found = match(pr.pattern) if pr.pattern and not pr.missing else []
            meters = [m for m, _ in found]
            for m, c in found:
                votes[m] = votes.get(m, 0) + 1
                costs[m] = costs.get(m, 0) + c
            item: dict[str, Any] = {
                "text": h, "pattern": pr.pattern, "meters": meters, "missing_marks": pr.missing,
            }  # fmt: skip
            if pr.pattern and not meters:
                m, k = best_partial(pr.pattern)
                item["closest"] = {"meter": m, "matched_letters": k, "break_at": k}
            hs.append(item)
        out_verses.append({"hemistichs": hs})
    # most hemistichs matched; ties -> the meter needing the fewest variations (simplest reading)
    ranked = sorted(votes.items(), key=lambda kv: (-kv[1], costs[kv[0]], list(METERS).index(kv[0])))
    best = ranked[0][0] if ranked else None
    return {
        "meter": best,
        "matched_hemistichs": votes.get(best, 0) if best else 0,
        "hemistichs": total,
        "candidates": [{"meter": m, "hemistichs": n, "variations": costs[m]} for m, n in ranked],
        "verses": out_verses,
        "limits": LIMITS,
    }


__all__ = ["METERS", "analyze", "hemistich_patterns", "hemistich_pattern", "match", "split_verses"]
