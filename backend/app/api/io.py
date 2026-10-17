from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.core.database import connect
from app.core.errors import not_found, validation_error
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline
from app.io import batch, formats, ocr
from app.io.convert import convert_file

router = APIRouter(tags=["io"])
Mode = Literal["fast", "accurate"]
Level = Literal["full", "irab_only", "minimal", "legal"]


def _abs(raw: str, field: str) -> Path:
    p = Path(raw)
    if not p.is_absolute():
        raise validation_error(f"{field} must be an absolute path", {"field": field})
    return p


class ConvertIn(BaseModel):
    input_path: str
    output_path: str
    mode: Mode = "fast"
    level: Level = "full"
    track_changes: bool = False
    include_comments: bool = False


class TrackIn(BaseModel):
    source_path: str
    target_path: str
    mode: Mode = "fast"
    level: Level = "full"
    include_comments: bool = False


class ImportIn(BaseModel):
    path: str


class ExportIn(BaseModel):
    target_path: str
    text: str | None = None
    document_id: int | None = None
    title: str = ""
    font_path: str | None = None


class OcrIn(BaseModel):
    path: str
    lang: str = Field(default="ara", pattern=r"^[A-Za-z_+]{2,30}$")
    dpi: int = Field(default=300, ge=72, le=600)
    pages: list[int] | None = None
    force_ocr: bool = False


class BatchIn(BaseModel):
    input_dir: str
    output_dir: str
    mode: Mode = "fast"
    level: Level = "full"
    formats: list[str] = Field(default_factory=lambda: ["docx", "txt", "md", "srt", "epub"])
    recursive: bool = True
    on_exist: Literal["skip", "rename", "overwrite"] = "rename"
    track_changes: bool = False


@router.get("/api/io/formats")
async def list_formats() -> dict[str, Any]:
    return {
        "import": ["docx", "txt", "md", "srt", "epub", "pdf"],
        "diacritize": ["docx", "txt", "md", "srt", "epub", "pdf->txt"],
        "export": ["txt", "md", "srt", "pdf"],
        "encodings": ["utf-8", "utf-8-sig", "utf-16", "cp1256"],
    }


async def _convert(
    src: str, dst: str, mode: str, level: str, track: bool, comments: bool, db_path: Path
) -> dict[str, Any]:
    s, d = _abs(src, "input_path"), _abs(dst, "output_path")
    if not s.is_file():
        raise not_found("File", str(s))
    if not d.parent.is_dir():
        raise validation_error("output directory does not exist", {"dir": str(d.parent)})
    pipeline = await build_pipeline(mode, level, True)
    stats = await run_blocking(convert_file, s, d, pipeline, db_path, track, comments)
    return {"output_path": str(d), "stats": stats}


@router.post("/api/io/convert")
async def convert(body: ConvertIn, request: Request) -> dict[str, Any]:
    return await _convert(
        body.input_path, body.output_path, body.mode, body.level, body.track_changes,
        body.include_comments, request.app.state.db_path,
    )  # fmt: skip


@router.post("/api/io/docx/track-changes")
async def track_changes(body: TrackIn, request: Request) -> dict[str, Any]:
    if (
        Path(body.source_path).suffix.lower() != ".docx"
        or Path(body.target_path).suffix.lower() != ".docx"
    ):
        raise validation_error("both paths must end with .docx")
    return await _convert(
        body.source_path, body.target_path, body.mode, body.level, True,
        body.include_comments, request.app.state.db_path,
    )  # fmt: skip


def _import(path: Path) -> dict[str, Any]:
    fmt = formats.format_of(path)
    enc = None
    info: dict[str, Any] = {}
    if fmt == "docx":
        from app.docx.service import extract_plain_text

        text, info = extract_plain_text(path)
    elif fmt == "epub":
        text = formats.epub_text(path)
    elif fmt == "pdf":
        text, info = formats.pdf_import_text(path)
    else:
        text, enc = formats.read_text_file(path)
    return {"format": fmt, "encoding": enc, "text": text, "stats": info}


@router.post("/api/io/import")
async def import_file(body: ImportIn) -> dict[str, Any]:
    p = _abs(body.path, "path")
    if not p.is_file():
        raise not_found("File", str(p))
    return await run_blocking(_import, p)


def _export(db_path: Path, body: ExportIn) -> dict[str, Any]:
    dst = _abs(body.target_path, "target_path")
    if not dst.parent.is_dir():
        raise validation_error("target directory does not exist", {"dir": str(dst.parent)})
    text, title = body.text, body.title
    if text is None:
        if body.document_id is None:
            raise validation_error("text or document_id is required")
        conn = connect(db_path)
        try:
            row = conn.execute(
                "SELECT title, raw_content, diacritized_content FROM documents "
                "WHERE id=? AND is_deleted=0",
                (body.document_id,),
            ).fetchone()
        finally:
            conn.close()
        if row is None:
            raise not_found("Document", body.document_id)
        text, title = row["diacritized_content"] or row["raw_content"], title or row["title"]
    ext = dst.suffix.lower()
    if ext == ".pdf":
        info = formats.pdf_export(dst, text, title, body.font_path)
    elif ext in formats.TEXT_FORMATS:
        formats.write_text_file(dst, text)
        info = {}
    else:
        raise validation_error("export supports .txt .md .srt .pdf", {"ext": ext})
    return {"output_path": str(dst), "format": ext.lstrip("."), **info}


@router.post("/api/io/export")
async def export(body: ExportIn, request: Request) -> dict[str, Any]:
    return await run_blocking(_export, request.app.state.db_path, body)


@router.post("/api/ocr")
async def ocr_endpoint(body: OcrIn) -> dict[str, Any]:
    return await asyncio.to_thread(
        ocr.ocr_path, Path(body.path), body.lang, body.dpi, body.pages, body.force_ocr
    )


# ---------------------------------------------------------------- batch
@router.post("/api/batch", status_code=202)
async def batch_start(body: BatchIn, request: Request) -> dict[str, Any]:
    job = await batch.start(
        request.app.state.db_path, body.input_dir, body.output_dir, body.mode, body.level,
        body.formats, body.recursive, body.on_exist, body.track_changes,
    )  # fmt: skip
    return {"job_id": job.id, "total": job.fields["total"]}


def _job(job_id: str):
    job = batch.JOBS.get(job_id)
    if job is None:
        raise not_found("Job", job_id)
    return job


@router.get("/api/batch/{job_id}")
async def batch_status(job_id: str) -> dict[str, Any]:
    return _job(job_id).snapshot()


@router.post("/api/batch/{job_id}/cancel")
async def batch_cancel(job_id: str) -> dict[str, Any]:
    job = _job(job_id)
    job.cancel_event.set()
    return job.snapshot()


@router.get("/api/batch/{job_id}/events")
async def batch_events(job_id: str) -> StreamingResponse:
    job = _job(job_id)

    async def gen():
        last = None
        while True:
            snap = job.snapshot()
            key = (snap["status"], snap.get("done"))
            if key != last:
                last = key
                yield f"data: {json.dumps(snap, ensure_ascii=False)}\n\n"
            if job.finished:
                return
            await asyncio.sleep(0.2)

    return StreamingResponse(gen(), media_type="text/event-stream")
