from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.api.documents import count_words
from app.api.settings import DEFAULTS
from app.core.database import connect, now_iso, write
from app.core.errors import not_found, validation_error
from app.docx.service import diacritize_docx, extract_plain_text, process_text_docx
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline

router = APIRouter(prefix="/api/docx", tags=["docx"])


def _check_path(raw: str, field: str) -> Path:
    p = Path(raw)
    if not p.is_absolute() or p.suffix.lower() != ".docx":
        raise validation_error(
            f"{field} must be an absolute path ending with .docx", {"field": field}
        )
    return p


class ImportRequest(BaseModel):
    path: str
    project_id: int
    title: str | None = None


class ExportRequest(BaseModel):
    document_id: int | None = None
    source_path: str | None = None
    target_path: str
    mode: Literal["fast", "accurate"] = "fast"
    level: Literal["full", "irab_only", "minimal", "legal"] = "full"
    include_comments: bool = False


def _do_import(db_path: Path, path: Path, project_id: int, title: str | None) -> dict[str, Any]:
    if not path.is_file():
        raise not_found("File", str(path))
    text, stats = extract_plain_text(path)
    conn = connect(db_path)
    try:
        if conn.execute("SELECT 1 FROM projects WHERE id=?", (project_id,)).fetchone() is None:
            raise not_found("Project", project_id)
        ts = now_iso()
        name = (title or "").strip() or path.stem
        with write(conn):
            cur = conn.execute(
                "INSERT INTO documents(project_id, title, raw_content, source_docx_path, "
                "word_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (project_id, name, text, str(path), count_words(text), ts, ts),
            )
            doc_id = cur.lastrowid
            conn.execute(
                "INSERT INTO recent_files(file_path, document_id, last_opened_at) VALUES (?,?,?) "
                "ON CONFLICT(file_path) DO UPDATE SET document_id=excluded.document_id, "
                "last_opened_at=excluded.last_opened_at",
                (str(path), doc_id, ts),
            )
        return {
            "document_id": doc_id,
            "title": name,
            "word_count": count_words(text),
            "stats": stats,
        }
    finally:
        conn.close()


@router.post("/import", status_code=201)
async def import_docx(body: ImportRequest, request: Request) -> dict[str, Any]:
    path = _check_path(body.path, "path")
    return await run_blocking(
        _do_import, request.app.state.db_path, path, body.project_id, body.title
    )


def _resolve_source(db_path: Path, body: ExportRequest) -> dict[str, Any]:
    """Either {"src": Path} for an imported/Word file, or {"text": ..., "title": ...,
    "diacritized": bool, font settings} for a document with no source .docx (generate new)."""
    if (body.document_id is None) == (body.source_path is None):
        raise validation_error("provide exactly one of document_id or source_path")
    if body.source_path is not None:
        src = _check_path(body.source_path, "source_path")
        if not src.is_file():
            raise not_found("File", str(src))
        return {"src": src}
    conn: sqlite3.Connection = connect(db_path)
    try:
        row = conn.execute(
            "SELECT title, raw_content, diacritized_content, source_docx_path FROM documents "
            "WHERE id=? AND is_deleted=0",
            (body.document_id,),
        ).fetchone()
        if row is None:
            raise not_found("Document", body.document_id)
        if row["source_docx_path"] and Path(row["source_docx_path"]).is_file():
            return {"src": Path(row["source_docx_path"])}
        st = dict(conn.execute("SELECT key, value FROM settings").fetchall())
    finally:
        conn.close()
    try:
        size = int(st.get("editor_font_size", DEFAULTS["editor_font_size"]))
    except ValueError:
        size = int(DEFAULTS["editor_font_size"])
    diac = row["diacritized_content"] or ""
    return {
        "title": row["title"],
        "text": diac if diac.strip() else row["raw_content"],
        "diacritized": bool(diac.strip()),
        "font": st.get("editor_font") or DEFAULTS["editor_font"],
        "size_px": size,
    }


@router.post("/export")
async def export_docx(body: ExportRequest, request: Request) -> dict[str, Any]:
    target = _check_path(body.target_path, "target_path")
    db_path = request.app.state.db_path
    src = await run_blocking(_resolve_source, db_path, body)
    if "src" in src:
        stats = await diacritize_docx(
            src["src"], target, body.mode, body.level, body.include_comments, db_path
        )
    else:
        pipeline = None
        if not src["diacritized"]:
            pipeline = await build_pipeline(body.mode, body.level)
        stats = await run_blocking(
            process_text_docx,
            target,
            src["title"],
            src["text"],
            pipeline,
            db_path,
            src["font"],
            src["size_px"],
        )
    return {"target_path": str(target), "stats": stats}
