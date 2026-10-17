"""DOCX diacritization service: zip-level, non-destructive, atomic save."""

from __future__ import annotations

import copy
import errno
import logging
import os
import uuid
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml import parse_xml
from lxml import etree

from app.core.database import connect
from app.core.errors import disk_full, docx_corrupt, docx_write_locked, validation_error
from app.docx.extractor import (
    W_BR,
    W_CR,
    W_R,
    W_T,
    W_TAB,
    apply_unit,
    discover_parts,
    iter_units,
    owner_paragraph,
)
from app.docx.mixed import verify_mixed
from app.engine.executor import run_blocking
from app.engine.factory import build_pipeline
from app.engine.normalize import MARKS, WORD_RE, has_arabic_letters
from app.engine.pipeline import TashkeelPipeline

log = logging.getLogger("mizaj.docx")
TMP_PREFIX = ".~mizaj_tmp."
PART_KEYS = ("body", "headers", "footers", "footnotes", "endnotes", "textboxes", "sdt")


def _new_stats(include_comments: bool) -> dict[str, Any]:
    parts = dict.fromkeys(PART_KEYS, 0)
    if include_comments:
        parts["comments"] = 0
    return {
        "paragraphs": 0,
        "words_diacritized": 0,
        "skipped_code_runs": 0,
        "parts": parts,
    }


def open_source(src: Path):
    """Open `src` with python-docx; map every structural failure to ERR_DOCX_CORRUPT."""
    try:
        return Document(str(src))
    except FileNotFoundError:
        raise
    except Exception as exc:
        raise docx_corrupt(f"{type(exc).__name__}: {exc}") from exc


def _serialize(root) -> bytes:
    return etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)


def _atomic_write(dst: Path, write_fn: Callable[[Any], None]) -> None:
    """Write via a unique temp file next to `dst`, fsync, then os.replace."""
    tmp = dst.parent / f"{TMP_PREFIX}{uuid.uuid4().hex[:12]}.docx"
    try:
        with open(tmp, "wb") as fh:
            write_fn(fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, dst)
    except PermissionError as exc:
        raise docx_write_locked(str(dst)) from exc
    except OSError as exc:
        if exc.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)):
            raise disk_full(str(dst)) from exc
        raise
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            log.warning("could not remove temp file %s", tmp)


def _write_atomic(src: Path, dst: Path, modified: dict[str, bytes]) -> None:
    def write(fh) -> None:
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(fh, "w") as zout:
            for info in zin.infolist():
                data = modified.get(info.filename)
                if data is None:
                    data = zin.read(info)
                zout.writestr(copy.copy(info), data, compress_type=info.compress_type)

    _atomic_write(dst, write)


def process_docx(
    src: Path,
    dst: Path,
    pipeline: TashkeelPipeline,
    db_path: Path,
    include_comments: bool = False,
) -> dict[str, Any]:
    """Blocking implementation (run it in the engine executor)."""
    src, dst = Path(src), Path(dst)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    if dst.resolve() == src.resolve():
        raise validation_error("target_path must differ from the source file")
    if not dst.parent.is_dir():
        raise validation_error("target directory does not exist", {"dir": str(dst.parent)})
    doc = open_source(src)
    parts = discover_parts(doc, include_comments)
    stats = _new_stats(include_comments)
    modified: dict[str, bytes] = {}
    conn = connect(db_path)
    try:
        with zipfile.ZipFile(src) as zin:
            for name, kind in parts:
                try:
                    root = parse_xml(zin.read(name))
                except (KeyError, etree.XMLSyntaxError, zipfile.BadZipFile) as exc:
                    raise docx_corrupt(f"{name}: {exc}") from exc
                changed_part = False
                for unit in iter_units(root, kind):
                    stats["skipped_code_runs"] += unit.skipped_code_runs
                    if not unit.t_nodes:
                        continue
                    stats["paragraphs"] += 1
                    stats["parts"][unit.category] += 1
                    if not has_arabic_letters(unit.text):
                        continue
                    out = pipeline.run_text(conn, unit.text)
                    if not verify_mixed(unit.text, out):
                        log.error("mixed-text verification failed; paragraph left unchanged")
                        continue
                    changed, _ = apply_unit(unit, out)
                    changed_part |= changed
                    stats["words_diacritized"] += sum(
                        1
                        for m in WORD_RE.finditer(out)
                        if has_arabic_letters(m.group(0)) and any(c in MARKS for c in m.group(0))
                    )
                if changed_part:
                    modified[name] = _serialize(root)
    finally:
        conn.close()
    _write_atomic(src, dst, modified)
    return stats


async def diacritize_docx(
    src: Path,
    dst: Path,
    mode: str,
    level: str,
    include_comments: bool,
    db_path: Path,
    keep_existing: bool = True,
) -> dict[str, Any]:
    """Async entry point: builds the Phase 2 pipeline, then runs off the event loop."""
    pipeline = await build_pipeline(mode, level, keep_existing)
    return await run_blocking(process_docx, src, dst, pipeline, db_path, include_comments)


def extract_plain_text(src: Path) -> tuple[str, dict[str, Any]]:
    """Plain text of the body (paragraphs joined by newlines) and import stats."""
    doc = open_source(src)
    name = doc.part.partname.lstrip("/")
    try:
        with zipfile.ZipFile(src) as zin:
            root = parse_xml(zin.read(name))
    except (KeyError, etree.XMLSyntaxError, zipfile.BadZipFile) as exc:
        raise docx_corrupt(str(exc)) from exc
    lines: list[str] = []
    stats = {"paragraphs": 0, "words": 0, "tables": len(doc.tables), "skipped_code_runs": 0}
    for unit in iter_units(root, "body"):
        if unit.category not in ("body", "sdt"):
            continue  # text boxes are exported with the file but not part of the flow text
        stats["skipped_code_runs"] += unit.skipped_code_runs
        lines.append(_plain(unit))
        stats["paragraphs"] += 1
    text = "\n".join(lines)
    stats["words"] = len(text.split())
    return text, stats


def _plain(unit) -> str:
    """Visible text of a paragraph including code-run text (unlike `unit.text`)."""
    parts: list[str] = []
    for r in unit.p.iter(W_R):
        if owner_paragraph(r) is not unit.p:
            continue
        for c in r:
            if c.tag == W_T:
                parts.append(c.text or "")
            elif c.tag == W_TAB:
                parts.append("\t")
            elif c.tag in (W_BR, W_CR):
                parts.append("\n")
    return "".join(parts)


PX_TO_PT = 0.75


def build_docx_from_text(
    title: str,
    text: str,
    font: str = "Amiri",
    size_px: int = 20,
    rtl: bool = True,
):
    """A clean RTL python-docx Document: one paragraph per line (blank lines preserved), Arabic
    (complex-script) font and size on the defaults, `w:bidi` on every paragraph and the
    section, `w:rtl` + `ar-SA` on every run."""
    from docx import Document
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.shared import Pt

    doc = Document()
    doc.core_properties.title = title
    doc.core_properties.language = "ar-SA"
    size_pt = Pt(round(size_px * PX_TO_PT * 2) / 2)
    normal = doc.styles["Normal"]
    normal.font.name = font
    normal.font.size = size_pt
    rpr = normal.element.get_or_add_rPr()
    rfonts = rpr.get_or_add_rFonts()
    for attr in ("ascii", "hAnsi", "cs", "eastAsia"):
        rfonts.set(qn(f"w:{attr}"), font)
    if rtl:
        sz_cs = OxmlElement("w:szCs")
        sz_cs.set(qn("w:val"), str(int(size_pt.pt * 2)))
        rpr.append(sz_cs)
        lang = OxmlElement("w:lang")
        lang.set(qn("w:val"), "en-US")
        lang.set(qn("w:bidi"), "ar-SA")
        rpr.append(lang)
        ppr = normal.element.get_or_add_pPr()
        ppr.append(OxmlElement("w:bidi"))
        doc.sections[0]._sectPr.append(OxmlElement("w:bidi"))
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for line in lines:
        p = doc.add_paragraph()
        if rtl:
            p._p.get_or_add_pPr().append(OxmlElement("w:bidi"))
        if line:
            run = p.add_run(line)
            if rtl:
                run._r.get_or_add_rPr().append(OxmlElement("w:rtl"))
    return doc, len(lines)


def process_text_docx(
    dst: Path,
    title: str,
    text: str,
    pipeline: TashkeelPipeline | None,
    db_path: Path,
    font: str = "Amiri",
    size_px: int = 20,
) -> dict[str, Any]:
    """Blocking: (diacritize `text` when a pipeline is given) and write a new .docx atomically."""
    dst = Path(dst)
    if not dst.parent.is_dir():
        raise validation_error("target directory does not exist", {"dir": str(dst.parent)})
    if pipeline is not None and has_arabic_letters(text):
        conn = connect(db_path)
        try:
            text = pipeline.run_text(conn, text)
        finally:
            conn.close()
    doc, n = build_docx_from_text(title, text, font, size_px)
    _atomic_write(dst, lambda fh: doc.save(fh))
    words = sum(
        1
        for m in WORD_RE.finditer(text)
        if has_arabic_letters(m.group(0)) and any(c in MARKS for c in m.group(0))
    )
    parts = dict.fromkeys(PART_KEYS, 0)
    parts["body"] = n
    return {"paragraphs": n, "words_diacritized": words, "skipped_code_runs": 0, "parts": parts}
