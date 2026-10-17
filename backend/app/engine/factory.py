"""Builds a TashkeelPipeline for (mode, level); shared by the text and DOCX endpoints."""

from __future__ import annotations

import json
from pathlib import Path

from app.engine import config
from app.engine.executor import run_blocking
from app.engine.manager import manager
from app.engine.pipeline import TashkeelPipeline

_RULES = Path(__file__).resolve().parent / "data" / "minimal_rules.json"


def _load_glossary(conn):
    from app.legal.glossary import GlossaryIndex, load_entries

    return GlossaryIndex(load_entries(conn))


def _minimal_words() -> frozenset[str]:
    return frozenset(json.loads(_RULES.read_text(encoding="utf-8"))["always_diacritize"])


def quran_protector():
    """`find_protected_spans(text) -> [(start, end)]` from app.quran when that module exists."""
    try:
        from app.quran import find_protected_spans
    except ImportError:
        return None
    return find_protected_spans


async def build_pipeline(
    mode: str,
    level: str,
    keep_existing: bool = True,
    morph_filter: bool | None = None,
    use_cache: bool = True,
    irab_rules: bool = False,
    use_names: bool = True,
    protect_quran: bool = True,
) -> TashkeelPipeline:
    from app.engine.names import names_index

    engine = await manager.ensure(mode)
    morph = None
    use_filter = config.morph_filter_default() if morph_filter is None else morph_filter
    if engine.name == "catt" and use_filter:
        morph = await run_blocking(manager.morph_filter)
    ambiguity = passive = glossary_loader = irab_noun = None
    need_oracle = level in ("minimal", "legal")
    if need_oracle or (irab_rules and engine.name != "mock"):
        oracle = engine if engine.name == "mock" else await manager.ensure_key("mishkal", mode)
        if need_oracle:
            ambiguity = oracle.is_ambiguous
            # the mock engine never produces passive vowel patterns, so it has no passive oracle
            passive = getattr(oracle, "is_passive_form", None)
            if level == "legal":
                glossary_loader = _load_glossary
        if irab_rules:
            irab_noun = getattr(oracle, "is_noun_only", None)
    return TashkeelPipeline(
        engine,
        level=level,
        keep_existing=keep_existing,
        morph=morph,
        ambiguity=ambiguity,
        use_cache=use_cache,
        passive=passive,
        glossary_loader=glossary_loader,
        names_loader=names_index if use_names else None,
        irab_noun=irab_noun,
        irab_rules_on=irab_rules,
        conf_threshold=config.confidence_threshold(),
        irab_threshold=config.irab_threshold(),
        minimal_words=_minimal_words(),
        protector=quran_protector() if protect_quran else None,
    )
