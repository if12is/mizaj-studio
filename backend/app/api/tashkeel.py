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
from app.engine.pipeline import TashkeelPipeline
from app.engine.splitter import ArabicSentenceSplitter

log = logging.getLogger("mizaj.api.tashkeel")
router = APIRouter(tags=["tashkeel"])

Mode = Literal["fast", "accurate"]
Level = Literal["full", "irab_only", "minimal", "legal"]
MAX_TEXT = 5_000_000


class TashkeelRequest(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    mode: Mode = "fast"
    level: Level | None = None
    keep_existing: bool = True
    morph_filter: bool | None = None
    use_cache: bool = True  # False: bypass the chunk cache only (dictionary still applies)


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
        body.mode, body.level or level, body.keep_existing, body.morph_filter, body.use_cache
    )
    engine = pipeline.engine
    return engine, pipeline


def _run_all(db_path: Path, pipeline: TashkeelPipeline, text: str) -> str:
    conn = connect(db_path)
    try:
        return pipeline.run_text(conn, text)
    finally:
        conn.close()


@router.post("/api/tashkeel")
async def tashkeel(body: TashkeelRequest, request: Request) -> dict[str, Any]:
    t0 = time.perf_counter()
    engine, pipeline = await _build_pipeline(request, body)
    out = await run_blocking(_run_all, request.app.state.db_path, pipeline, body.text)
    return {
        "text": out,
        "engine": engine.name,
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
    }


def _sse(data: dict[str, Any], event: str | None = None) -> str:
    head = f"event: {event}\n" if event else ""
    return f"{head}data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/api/tashkeel/stream")
async def tashkeel_stream(body: StreamRequest, request: Request) -> StreamingResponse:
    engine, pipeline = await _build_pipeline(request, body, body.document_id)
    text = body.text
    cmap = ChunkMap.build(text, ArabicSentenceSplitter())
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
                res = await run_blocking(pipeline.process_chunk, conn, chunk.text)
                words += res.words
                cached_chunks += res.cached
                last = chunk.index == len(cmap.chunks) - 1
                elapsed = max(time.perf_counter() - t0, 1e-6)
                yield _sse(
                    {
                        "chunk_id": chunk.index + 1,
                        "start": chunk.start,
                        "end": chunk.end,
                        "text": res.text,
                        "progress": 100 if last else min(99, chunk.end * 100 // total),
                        "wps": round(words / elapsed, 1),
                        "cached": res.cached,
                    }
                )
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
