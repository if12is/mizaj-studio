from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.api.settings import DEFAULTS
from app.core.database import connect
from app.core.errors import MizajError, not_found, task_cancelled, validation_error
from app.engine.cache import TashkeelCache
from app.engine.chunk_map import ChunkMap
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline
from app.engine.manager import manager
from app.engine.normalize import has_arabic_letters, strip_marks
from app.engine.pipeline import TashkeelPipeline, local_spans, neighbour_context
from app.engine.splitter import ArabicSentenceSplitter

log = logging.getLogger("mizaj.api.tashkeel")
router = APIRouter(tags=["tashkeel"])

Mode = Literal["fast", "accurate"]
Level = Literal["full", "irab_only", "essential", "minimal", "legal"]
MAX_TEXT = 5_000_000


class TashkeelRequest(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    mode: Mode = "fast"
    level: Level | None = None
    keep_existing: bool = True
    morph_filter: bool | None = None
    use_cache: bool = True  # False: bypass the chunk cache only (dictionary still applies)
    confidence: bool = False  # add low-confidence words to the response / SSE chunk events
    confidence_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    irab_rules: bool = False  # conservative context rules for case endings (7.1.6)
    use_names: bool = True  # proper-noun dictionary (7.4.3)
    protect_quran: bool = True  # leave Quran spans untouched when the detector is available
    grammar_fixes: bool = True  # legal lexicon + grammar rules (engine/legal_fix.py)
    poetry: bool = False  # keep every line as its own chunk (verse structure)


class StreamRequest(TashkeelRequest):
    document_id: int | None = None


def _read_setting_and_doc(db_path: Path, document_id: int | None) -> tuple[str, bool]:
    conn = connect(db_path)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key='tashkeel_level'").fetchone()
        level = row["value"] if row else DEFAULTS["tashkeel_level"]
        doc_ok = True
        if document_id is not None:
            doc_ok = (
                conn.execute(
                    "SELECT 1 FROM documents WHERE id=? AND is_deleted=0", (document_id,)
                ).fetchone()
                is not None
            )
        return level, doc_ok
    finally:
        conn.close()


async def _build_pipeline(request: Request, body: TashkeelRequest, document_id=None):
    db_path = request.app.state.db_path
    level, doc_ok = await run_blocking(_read_setting_and_doc, db_path, document_id)
    if not doc_ok:
        raise not_found("Document", document_id)
    pipeline = await build_pipeline(
        body.mode,
        body.level or level,
        body.keep_existing,
        body.morph_filter,
        body.use_cache,
        irab_rules=body.irab_rules,
        use_names=body.use_names,
        protect_quran=body.protect_quran,
        grammar_fixes=body.grammar_fixes,
    )
    if body.poetry:
        pipeline.splitter = ArabicSentenceSplitter(line_mode=True)
    engine = pipeline.engine
    return engine, pipeline


def _run_all(db_path: Path, pipeline: TashkeelPipeline, text: str):
    conn = connect(db_path)
    try:
        return pipeline.run_text_ex(conn, text)
    finally:
        conn.close()


def u16_offsets(text: str, positions: list[int]) -> dict[int, int]:
    """UTF-16 code-unit offset for each code-point position (for JavaScript clients)."""
    want = set(positions)
    out: dict[int, int] = {}
    units = 0
    for i, ch in enumerate(text):
        if i in want:
            out[i] = units
        units += 2 if ord(ch) > 0xFFFF else 1
    if len(text) in want:
        out[len(text)] = units
    return out


def low_conf_words(text: str, words, threshold: float, base: int = 0) -> list[dict[str, Any]]:
    """Compact list of the words whose confidence is below `threshold` (None = unknown, skipped).
    `start`/`end` are code points; `u16_start`/`u16_end` UTF-16 units; both relative to `text`
    (+`base`, the chunk offset in the document, when given)."""
    flagged = [w for w in words if w[2] is not None and min(w[2], 1.0) < threshold]
    pos = [p for w in flagged for p in (w[0], w[1])]
    u16 = u16_offsets(text, pos)
    return [
        {
            "start": s + base,
            "end": e + base,
            "u16_start": u16[s] + base,
            "u16_end": u16[e] + base,
            "confidence": round(wc, 3),
            "irab_confidence": None if ic is None else round(ic, 3),
        }
        for s, e, wc, ic in flagged
    ]


@router.post("/api/tashkeel")
async def tashkeel(body: TashkeelRequest, request: Request) -> dict[str, Any]:
    t0 = time.perf_counter()
    engine, pipeline = await _build_pipeline(request, body)
    out, wconf = await run_blocking(_run_all, request.app.state.db_path, pipeline, body.text)
    resp: dict[str, Any] = {
        "text": out,
        "engine": engine.name,
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
    }
    if body.confidence:
        thr = (
            body.confidence_threshold
            if body.confidence_threshold is not None
            else pipeline.conf_threshold
        )
        resp["words"] = low_conf_words(out, wconf, thr)
        resp["confidence_threshold"] = thr
    return resp


def _sse(data: dict[str, Any], event: str | None = None) -> str:
    head = f"event: {event}\n" if event else ""
    return f"{head}data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/api/tashkeel/stream")
async def tashkeel_stream(body: StreamRequest, request: Request) -> StreamingResponse:
    engine, pipeline = await _build_pipeline(request, body, body.document_id)
    text = body.text
    cmap = ChunkMap.build(text, pipeline.splitter)
    protected = pipeline.protected_spans(text)
    thr = (
        body.confidence_threshold
        if body.confidence_threshold is not None
        else pipeline.conf_threshold
    )
    db_path = request.app.state.db_path

    async def gen() -> AsyncIterator[str]:
        conn = connect(db_path, check_same_thread=False)
        t0 = time.perf_counter()
        words = cached_chunks = 0
        total = len(text) or 1
        try:
            for chunk in cmap.chunks:
                if await request.is_disconnected():
                    err = task_cancelled()
                    log.info("%s: client disconnected after %d chunks", err.error_code, chunk.index)
                    return
                res = await run_blocking(
                    pipeline.process_chunk,
                    conn,
                    chunk.text,
                    local_spans(protected, chunk.start, chunk.end),
                    *neighbour_context(cmap, chunk.index),
                )
                words += res.words
                cached_chunks += res.cached
                last = chunk.index == len(cmap.chunks) - 1
                elapsed = max(time.perf_counter() - t0, 1e-6)
                event = {
                    "chunk_id": chunk.index + 1,
                    "start": chunk.start,
                    "end": chunk.end,
                    "text": res.text,
                    "progress": 100 if last else min(99, chunk.end * 100 // total),
                    "wps": round(words / elapsed, 1),
                    "cached": res.cached,
                }
                if body.confidence:  # offsets are relative to this chunk's `text`
                    event["words"] = low_conf_words(res.text, res.word_conf, thr)
                yield _sse(event)
            elapsed = time.perf_counter() - t0
            yield _sse(
                {
                    "chunks": len(cmap.chunks),
                    "cached_chunks": cached_chunks,
                    "words": words,
                    "progress": 100,
                    "engine": engine.name,
                    "document_id": body.document_id,
                    "elapsed_ms": int(elapsed * 1000),
                    "wps": round(words / max(elapsed, 1e-6), 1),
                },
                event="done",
            )
        except asyncio.CancelledError:
            log.info("%s: stream cancelled", task_cancelled().error_code)
            raise
        except MizajError as exc:
            yield _sse(exc.envelope(), event="error")
        except Exception:
            log.exception("stream failed")
            yield _sse(
                {
                    "error_code": "ERR_INTERNAL",
                    "message_ar": "حدث خطأ داخلي.",
                    "message_en": "Internal server error.",
                    "details": {},
                },
                event="error",
            )
        finally:
            conn.close()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _suggest(db_path: Path, engine, word: str) -> list[dict[str, str]]:
    sugg = engine.suggestions(word)
    conn = connect(db_path)
    try:
        locked = TashkeelCache(conn).locked_words([word])
    finally:
        conn.close()
    form = locked.get(word)
    if form:
        sugg = [{"diacritized": form, "pos": "قاموس المستخدم"}] + [
            s for s in sugg if s["diacritized"] != form
        ]
    return sugg


@router.get("/api/word-suggestions")
async def word_suggestions(word: str, request: Request) -> list[dict[str, str]]:
    bare = strip_marks(word).strip()
    if not bare or not has_arabic_letters(bare) or len(bare.split()) != 1:
        raise validation_error("word must be a single Arabic word", {"field": "word"})
    engine = await manager.ensure_analyzer()
    return await run_blocking(_suggest, request.app.state.db_path, engine, bare)
