"""Single-file conversion entry points shared by /api/io and /api/batch (blocking)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.database import connect
from app.core.errors import validation_error
from app.docx.service import process_docx
from app.engine.normalize import MARKS, WORD_RE, has_arabic_letters
from app.engine.pipeline import TashkeelPipeline
from app.io import formats
from app.io.trackchanges import process_docx_tracked


def _count_marked(text: str) -> int:
    return sum(
        1
        for m in WORD_RE.finditer(text)
        if has_arabic_letters(m.group(0)) and any(c in MARKS for c in m.group(0))
    )


def convert_file(
    src: Path,
    dst: Path,
    pipeline: TashkeelPipeline,
    db_path: Path,
    track_changes: bool = False,
    include_comments: bool = False,
) -> dict[str, Any]:
    """Diacritize `src` into `dst` (same format; PDF -> .txt). Never touches `src`."""
    src, dst = Path(src), Path(dst)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    if dst.resolve() == src.resolve():
        raise validation_error("output path must differ from the input file")
    fmt = formats.format_of(src)
    if fmt == "docx":
        if track_changes:
            return process_docx_tracked(src, dst, pipeline, db_path, include_comments)
        return process_docx(src, dst, pipeline, db_path, include_comments)
    conn = connect(db_path)
    try:

        def fn(t: str) -> str:
            return pipeline.run_text(conn, t)

        if fmt == "epub":
            stats = formats.diacritize_epub(src, dst, fn)
            return {"format": "epub", **stats}
        if fmt == "pdf":
            text, info = formats.pdf_import_text(src)
            out = fn(text)
            formats.write_text_file(dst, out)
            return {"format": "pdf->txt", "words_diacritized": _count_marked(out), **info}
        text, enc = formats.read_text_file(src)
        crlf = "\r\n" in text
        norm = text.replace("\r\n", "\n")
        out = formats.diacritize_text_format(fmt, norm, fn)
        if crlf:
            out = out.replace("\n", "\r\n")
        formats.write_text_file(dst, out, bom=enc == "utf-8-sig")
        return {
            "format": fmt,
            "source_encoding": enc,
            "words_diacritized": _count_marked(out),
        }
    finally:
        conn.close()
