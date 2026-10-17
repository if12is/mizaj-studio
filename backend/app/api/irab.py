from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Query, Request

from app.core.errors import validation_error
from app.engine.executor import run_blocking
from app.engine.irab_explain import explain
from app.engine.manager import manager
from app.engine.normalize import WORD_RE, has_arabic_letters, strip_marks

router = APIRouter(prefix="/api/irab", tags=["irab"])


def _words(text: str) -> list[str]:
    return [
        m.group(0) for m in WORD_RE.finditer(strip_marks(text)) if has_arabic_letters(m.group(0))
    ]


def _run(analyzer, engine, word: str, context: str | None, index: int | None) -> dict[str, Any]:
    bare = strip_marks(word)
    chosen = None
    prev_words: list[str] = []
    prev_analyses = []
    if context:
        ctx = _words(context)
        pos = (
            index if index is not None else next((i for i, w in enumerate(ctx) if w == bare), None)
        )
        if pos is not None and 0 <= pos < len(ctx) and ctx[pos] == bare:
            outs = engine.diacritize(ctx)
            chosen = outs[pos]
            prev_words = ctx[:pos]
            prev_analyses = [analyzer.analyses(w) for w in prev_words[-2:]]
    res = explain(word, chosen, prev_words[-2:], analyzer.analyses(bare), prev_analyses)
    res["context_used"] = chosen is not None
    return res


@router.get("")
async def irab(
    request: Request,
    word: str = Query(min_length=1, max_length=60),
    context: str | None = Query(default=None, max_length=4000),
    index: int | None = Query(default=None, ge=0, description="word index within the context"),
    mode: Literal["fast", "accurate"] = "fast",
) -> dict[str, Any]:
    if not has_arabic_letters(strip_marks(word)) or len(strip_marks(word).split()) != 1:
        raise validation_error("word must be a single Arabic word", {"field": "word"})
    analyzer = await manager.ensure_analyzer()
    engine = await manager.ensure(mode)
    if not hasattr(analyzer, "analyses"):
        # mock mode has no morphological analyzer: be honest about it
        return {
            "word": word, "bare": strip_marks(word), "certainty": "unknown", "case": None,
            "sign": None, "role": None, "candidates": [], "context_used": False,
            "reason": "غير متأكد: المحلل الصرفي غير متاح في الوضع التجريبي.",
        }  # fmt: skip
    return await run_blocking(_run, analyzer, engine, word, context, index)
