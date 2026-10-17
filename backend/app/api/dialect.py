"""POST /api/text/dialect-hint: a cheap, closed-list heuristic (Task 7.4.5).

It only tells the UI that the text *looks* dialectal so it can warn that diacritization of dialect
is less reliable. It is not a dialect identifier, never changes any text, and a negative answer
does not mean the text is Modern Standard Arabic.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.engine.normalize import WORD_RE, has_arabic_letters, strip_marks

router = APIRouter(prefix="/api/text", tags=["text"])

# Whole-word markers, already normalised (alef forms -> ا, ى -> ي, ة kept). Weight 1.0 = strong,
# 0.5 = also occurs in standard Arabic or in several dialects (counts half).
_MARKERS: dict[str, dict[str, float]] = {
    "egyptian": {
        "ده": 1,
        "دي": 0.5,
        "دول": 1,
        "عايز": 1,
        "عايزه": 1,
        "عاوز": 1,
        "مش": 1,
        "ازاي": 1,
        "ليه": 0.5,
        "فين": 1,
        "دلوقتي": 1,
        "دلوقت": 1,
        "كده": 1,
        "بتاع": 1,
        "بتاعت": 1,
        "اوي": 1,
        "برضه": 1,
        "لسه": 1,
        "ايه": 1,
        "امتي": 1,
        "ماشي": 0.5,
        "خلاص": 0.5,
    },
    "gulf": {
        "وايد": 1,
        "شلون": 0.5,
        "شلونك": 1,
        "شفيك": 1,
        "ابغي": 1,
        "ابي": 0.5,
        "وش": 0.5,
        "ويش": 1,
        "هالحين": 1,
        "الحين": 1,
        "شنو": 1,
        "شنهو": 1,
        "يبا": 1,
        "هب": 0.5,
        "چذي": 1,
        "اللحين": 1,
    },
    "levantine": {
        "هلق": 1,
        "هلا": 0.5,
        "شو": 1,
        "كتير": 1,
        "بدي": 1,
        "بدك": 1,
        "بدنا": 1,
        "ليش": 0.5,
        "هيك": 1,
        "هاد": 1,
        "هاي": 0.5,
        "كيفك": 1,
        "منيح": 1,
        "لسا": 1,
        "شلون": 0.5,
        "قديش": 1,
        "هلأ": 1,
        "هلاء": 1,
        "ايش": 0.5,
        "مبارح": 1,
    },
}
_MARKERS = {d: {k: w for k, w in m.items() if w > 0} for d, m in _MARKERS.items()}
_ALEF = str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي"})


def norm(word: str) -> str:
    return strip_marks(word).replace("ـ", "").translate(_ALEF)


_INDEX: dict[str, list[tuple[str, float]]] = {}
for _dialect, _ms in _MARKERS.items():
    for _w, _wt in _ms.items():
        _INDEX.setdefault(norm(_w), []).append((_dialect, _wt))


def dialect_hint(text: str) -> dict[str, Any]:
    words = [m.group(0) for m in WORD_RE.finditer(text) if has_arabic_letters(m.group(0))]
    n = len(words)
    found: Counter[tuple[str, str]] = Counter()
    scores: dict[str, float] = {d: 0.0 for d in _MARKERS}
    total = 0.0
    for w in words:
        hits = _INDEX.get(norm(w))
        if not hits:
            continue
        # A word shared by several dialects counts once toward the total, split across dialects.
        wt = max(x for _, x in hits)
        total += wt
        for d, x in hits:
            scores[d] += x / len(hits)
            found[(norm(w), d)] += 1
    ratio = total / n if n else 0.0
    score = round(min(1.0, ratio * 6.0), 3)
    likely = n > 0 and ((total >= 2 and ratio >= 0.04) or score >= 0.5)
    best = max(scores, key=lambda d: scores[d]) if total else None
    return {
        "likely_dialectal": bool(likely),
        "score": score,
        "dialect": best if likely else None,
        "words": n,
        "markers": [
            {"word": w, "dialect": d, "count": c}
            for (w, d), c in sorted(found.items(), key=lambda kv: (-kv[1], kv[0]))
        ],
        "note_en": "Heuristic only: diacritization of dialectal text is less reliable.",
        "note_ar": "تقدير تقريبي فقط: تشكيل النص العامي أقل دقة.",
    }


class DialectIn(BaseModel):
    text: str = Field(default="", max_length=2_000_000)


@router.post("/dialect-hint")
def post_dialect_hint(body: DialectIn) -> dict[str, Any]:
    return dialect_hint(body.text)
