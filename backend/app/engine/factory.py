"""Builds a TashkeelPipeline for (mode, level); shared by the text and DOCX endpoints."""

from __future__ import annotations

from app.engine import config
from app.engine.executor import run_blocking
from app.engine.manager import manager
from app.engine.pipeline import TashkeelPipeline


async def build_pipeline(
    mode: str,
    level: str,
    keep_existing: bool = True,
    morph_filter: bool | None = None,
) -> TashkeelPipeline:
    engine = await manager.ensure(mode)
    morph = None
    use_filter = config.morph_filter_default() if morph_filter is None else morph_filter
    if engine.name == "catt" and use_filter:
        morph = await run_blocking(manager.morph_filter)
    ambiguity = None
    if level == "minimal":
        oracle = engine if engine.name == "mock" else await manager.ensure_key("mishkal", mode)
        ambiguity = oracle.is_ambiguous
    return TashkeelPipeline(
        engine, level=level, keep_existing=keep_existing, morph=morph, ambiguity=ambiguity
    )
