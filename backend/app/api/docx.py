from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

from app.api.documents import count_words
from app.api.settings import DEFAULTS
from app.core import security
from app.core import versions as vs
from app.core.database import connect, now_iso, write
from app.core.errors import MizajError, not_found, validation_error
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline

router = APIRouter(prefix="/api/docx", tags=["docx"])


MAX_DOCX_BYTES = 256 * security.MB


def _check_path(raw: str, field: str) -> Path:
    """Syntax-only check (absolute, .docx, no UNC/device); the file checks happen in
    `_check_in` / `_check_out`."""
    security._syntax_check(raw, field)
    if Path(raw).suffix.lower() != ".docx":
        raise validation_error(
            f"{field} must be an absolute path ending with .docx", {"field": field}
        )
    return Path(raw)


def _check_in(raw: str, field: str) -> Path:
    return security.safe_path(raw, field, exts=(".docx",), max_bytes=MAX_DOCX_BYTES)


def _check_out(raw: str, field: str, data_dir: Path, src: Path | None = None) -> Path:
    return security.safe_path(
        raw, field, exts=(".docx",), kind="output", data_dir=data_dir, avoid=src
    )


class ImportRequest(BaseModel):
    path: str
    project_id: int
    title: str | None = None


class ExportRequest(BaseModel):
    document_id: int | None = None
    source_path: str | None = None
    target_path: str
    mode: Literal["fast", "accurate"] = "fast"
    level: Literal["full", "irab_only", "essential", "minimal", "legal"] = "full"
    include_comments: bool = False


def _do_import(db_path: Path, path: Path, project_id: int, title: str | None) -> dict[str, Any]:
    if not path.is_file():
        raise not_found("File", str(path))
    from app.docx.service import extract_plain_text  # lazy: python-docx/lxml (startup time)

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
            if text:
                vs.record_version(conn, doc_id, text, kind="initial", label=vs.LABEL_IMPORT)
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
    path = _check_in(body.path, "path")
    return await run_blocking(
        _do_import, request.app.state.db_path, path, body.project_id, body.title
    )


def _resolve_source(db_path: Path, body: ExportRequest) -> dict[str, Any]:
    """Either {"src": Path} for an imported/Word file, or {"text": ..., "title": ...,
    "diacritized": bool, font settings} for a document with no source .docx (generate new)."""
    if (body.document_id is None) == (body.source_path is None):
        raise validation_error("provide exactly one of document_id or source_path")
    if body.source_path is not None:
        return {"src": _check_in(body.source_path, "source_path")}
    conn: sqlite3.Connection = connect(db_path)
    try:
        row = conn.execute(
            "SELECT title, raw_content, diacritized_content, source_docx_path FROM documents "
            "WHERE id=? AND is_deleted=0",
            (body.document_id,),
        ).fetchone()
        if row is None:
            raise not_found("Document", body.document_id)
        if row["source_docx_path"]:
            # the stored path may come from a restored backup: re-validate it (no UNC/devices)
            try:
                src = _check_in(row["source_docx_path"], "source_docx_path")
            except MizajError:
                src = None
            if src is not None:
                # what the editor holds (edits, manual marks, accepted proofreading) wins
                # over re-running the engine on the original file
                diac = row["diacritized_content"] or ""
                raw = row["raw_content"] or ""
                stored = diac if diac.strip() else raw
                return {
                    "src": src,
                    "stored": stored if stored.strip() else None,
                    "stored_diacritized": bool(diac.strip()),
                }
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
    _check_path(body.target_path, "target_path")
    db_path = request.app.state.db_path
    src = await run_blocking(_resolve_source, db_path, body)
    target = _check_out(body.target_path, "target_path", request.app.state.data_dir, src.get("src"))
    from app.docx.service import diacritize_docx, process_text_docx  # lazy (startup time)

    if "src" in src:
        stats = await diacritize_docx(
            src["src"],
            target,
            body.mode,
            body.level,
            body.include_comments,
            db_path,
            stored=src.get("stored"),
            stored_diacritized=src.get("stored_diacritized", False),
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


class TrackedExportRequest(BaseModel):
    document_id: int
    target_path: str
    scope: Literal["both", "proofread", "diacritics"] = "both"
    granularity: Literal["word", "char"] = "word"
    # the text before proofreading/tashkeel; only used when the document has no source .docx
    original_text: str | None = Field(default=None, max_length=20_000_000)


def _source_of(db_path: Path, document_id: int) -> str | None:
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT source_docx_path FROM documents WHERE id=? AND is_deleted=0", (document_id,)
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise not_found("Document", document_id)
    return row["source_docx_path"] or None


def _tracked_sync(
    db_path: Path, body: TrackedExportRequest, target: Path, data_dir: Path, src: Path | None
) -> dict[str, Any]:
    import tempfile

    from app.docx.service import _atomic_write, build_docx_from_text
    from app.docx.tracked import process_docx_edits_tracked

    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT title, raw_content, diacritized_content FROM documents "
            "WHERE id=? AND is_deleted=0",
            (body.document_id,),
        ).fetchone()
        if row is None:
            raise not_found("Document", body.document_id)
        st = dict(conn.execute("SELECT key, value FROM settings").fetchall())
    finally:
        conn.close()
    diac = row["diacritized_content"] or ""
    stored = diac if diac.strip() else (row["raw_content"] or "")
    if src is not None:
        return process_docx_edits_tracked(src, target, stored, body.scope, body.granularity)
    if body.original_text is None:
        raise validation_error("this document has no source .docx: original_text is required")
    try:
        size = int(st.get("editor_font_size", DEFAULTS["editor_font_size"]))
    except ValueError:
        size = int(DEFAULTS["editor_font_size"])
    doc, _n = build_docx_from_text(
        row["title"], body.original_text, st.get("editor_font") or DEFAULTS["editor_font"], size
    )
    with tempfile.TemporaryDirectory(dir=data_dir) as tmp:
        base = Path(tmp) / "original.docx"
        _atomic_write(base, lambda fh: doc.save(fh))
        return process_docx_edits_tracked(base, target, stored, body.scope, body.granularity)


@router.post("/export-tracked")
async def export_tracked(body: TrackedExportRequest, request: Request) -> dict[str, Any]:
    """The document as Word revisions (w:ins / w:del, author «مِزَاج») over its ORIGINAL file:
    proofreading changes, diacritization changes or both; accept-all = the editor text and
    reject-all = the original."""
    _check_path(body.target_path, "target_path")
    db_path = request.app.state.db_path
    data_dir = request.app.state.data_dir
    src_raw = await run_blocking(_source_of, db_path, body.document_id)
    src = None
    if src_raw:
        try:
            src = _check_in(src_raw, "source_docx_path")
        except MizajError:
            src = None
    target = _check_out(body.target_path, "target_path", data_dir, src)
    stats = await run_blocking(_tracked_sync, db_path, body, target, data_dir, src)
    return {"target_path": str(target), "stats": stats}


class RenderRequest(BaseModel):
    document_id: int
    diacritized: bool = False


def _render_sync(db_path: Path, body: RenderRequest) -> dict[str, Any]:
    from app.docx import render  # lazy: python-docx/lxml (startup time)

    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT title, raw_content, diacritized_content, source_docx_path FROM documents "
            "WHERE id=? AND is_deleted=0",
            (body.document_id,),
        ).fetchone()
        if row is None:
            raise not_found("Document", body.document_id)
        st = dict(conn.execute("SELECT key, value FROM settings").fetchall())
    finally:
        conn.close()
    diac = (row["diacritized_content"] or "") if body.diacritized else ""
    # what the export would write: diacritized text when asked for and present, else raw
    stored = diac if diac.strip() else (row["raw_content"] or "")
    if row["source_docx_path"]:
        try:
            src = _check_in(row["source_docx_path"], "source_docx_path")
        except MizajError:
            src = None
        if src is not None and src.is_file():
            return render.render_docx(src, stored if stored.strip() else None)
    try:
        size = int(st.get("editor_font_size", DEFAULTS["editor_font_size"]))
    except ValueError:
        size = int(DEFAULTS["editor_font_size"])
    text = diac if diac.strip() else row["raw_content"]
    return render.render_text(text, st.get("editor_font") or DEFAULTS["editor_font"], size)


@router.post("/render")
async def render_docx(body: RenderRequest, request: Request) -> dict[str, Any]:
    """Sanitized HTML of the document's page view (formatting from the source .docx)."""
    return await run_blocking(_render_sync, request.app.state.db_path, body)
