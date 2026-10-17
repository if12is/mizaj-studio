"""Builds a TashkeelPipeline for (mode, level); shared by the text and DOCX endpoints."""

from __future__ import annotations

from app.engine import config
from app.engine.executor import run_blocking
from app.engine.manager import manager
from app.engine.pipeline import TashkeelPipeline


def _load_glossary(conn):
    from app.legal.glossary import GlossaryIndex, load_entries

    return GlossaryIndex(load_entries(conn))


async def build_pipeline(
    mode: str,
    level: str,
    keep_existing: bool = True,
    morph_filter: bool | None = None,
    use_cache: bool = True,
) -> TashkeelPipeline:
    engine = await manager.ensure(mode)
    morph = None
    use_filter = config.morph_filter_default() if morph_filter is None else morph_filter
    if engine.name == "catt" and use_filter:
        morph = await run_blocking(manager.morph_filter)
    ambiguity = passive = glossary_loader = None
    if level in ("minimal", "legal"):
        oracle = engine if engine.name == "mock" else await manager.ensure_key("mishkal", mode)
        ambiguity = oracle.is_ambiguous
        if level == "legal":
            glossary_loader = _load_glossary
            # the mock engine never produces passive vowel patterns, so it has no passive oracle
            passive = getattr(oracle, "is_passive_form", None)
    return TashkeelPipeline(
        engine,
        level=level,
        keep_existing=keep_existing,
        morph=morph,
        ambiguity=ambiguity,
        use_cache=use_cache,
        passive=passive,
        glossary_loader=glossary_loader,
    )
