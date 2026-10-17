# ruff: noqa: E501
"""DOCX output where diacritization changes are Word revisions (w:del + w:ins, per word)."""

from __future__ import annotations

import copy
import logging
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn
from lxml import etree

from app.core.database import connect
from app.core.errors import docx_corrupt, validation_error
from app.docx.extractor import W_R, W_T, discover_parts, iter_units
from app.docx.mixed import verify_mixed
from app.docx.service import _serialize, _write_atomic, open_source
from app.engine.normalize import MARKS, WORD_RE, has_arabic_letters, split_pairs, strip_marks
from app.engine.pipeline import TashkeelPipeline

log = logging.getLogger("mizaj.trackchanges")
AUTHOR = "مِزَاج"
W_ID = qn("w:id")
W_INS, W_DEL, W_DELTEXT = qn("w:ins"), qn("w:del"), qn("w:delText")
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


class _Ids:
    def __init__(self, start: int) -> None:
        self.n = start

    def next(self) -> str:
        self.n += 1
        return str(self.n)


def _max_id(root) -> int:
    best = 0
    for el in root.iter():
        v = el.get(W_ID) if isinstance(el.tag, str) else None
        if v and v.lstrip("-").isdigit():
            best = max(best, int(v))
    return best


def _mk_run(rpr, tag: str, text: str):
    r = OxmlElement("w:r")
    if rpr is not None:
        r.append(copy.deepcopy(rpr))
    t = OxmlElement(tag)
    t.text = text
    t.set(XML_SPACE, "preserve")
    r.append(t)
    return r


def _revision(tag: str, ids: _Ids, date: str):
    el = OxmlElement(tag)
    el.set(W_ID, ids.next())
    el.set(qn("w:author"), AUTHOR)
    el.set(qn("w:date"), date)
    return el


def _isolate(t):
    """Put the w:t into a run of its own (copying rPr) and return that run."""
    r = t.getparent()
    kids = list(r)
    idx = kids.index(t)
    rpr = r.find(qn("w:rPr"))
    before = [k for k in kids[:idx] if k is not rpr]
    after = kids[idx + 1 :]
    if before:
        pre = OxmlElement("w:r")
        if rpr is not None:
            pre.append(copy.deepcopy(rpr))
        for k in before:
            pre.append(k)
        r.addprevious(pre)
    if after:
        post = OxmlElement("w:r")
        if rpr is not None:
            post.append(copy.deepcopy(rpr))
        for k in after:
            post.append(k)
        r.addnext(post)
    return r


def _word_ranges(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in WORD_RE.finditer(text) if has_arabic_letters(m.group(0))]


def track_unit(unit, out: str, ids: _Ids, date: str) -> tuple[int, int]:
    """Returns (revisions, untracked). Mutates the paragraph XML."""
    text = unit.text
    old_words = [(a, b) for a, b in _word_ranges(text)]
    new_words = [(a, b) for a, b in _word_ranges(out)]
    if len(old_words) != len(new_words):
        return 0, 0
    changed: list[tuple[int, int, str]] = []
    base_idx = [0] * (len(text) + 1)  # base-letter count before index i
    for i, ch in enumerate(text):
        base_idx[i + 1] = base_idx[i] + (0 if ch in MARKS else 1)
    pairs = split_pairs(out, canon=False)
    if len(pairs) != base_idx[-1]:
        return 0, 0
    for (a, b), (c, d) in zip(old_words, new_words, strict=True):
        if strip_marks(text[a:b]) != strip_marks(out[c:d]):
            return 0, 0
        if text[a:b] != out[c:d]:
            changed.append((a, b, out[c:d]))
    if not changed:
        return 0, 0
    revisions = untracked = 0
    # per owning w:t node: char index range
    spans: dict[int, list[int]] = {}
    order = []
    for i, node in enumerate(unit.owners):
        if node is None:
            continue
        k = id(node)
        if k not in spans:
            spans[k] = [i, i + 1]
            order.append(node)
        else:
            spans[k][1] = i + 1
    for t in order:
        s, e = spans[id(t)]
        pieces: list[tuple[bool, int, int]] = []  # (is_changed, lo, hi)
        pos = s
        for a, b, _new in changed:
            lo, hi = max(a, s), min(b, e)
            if lo >= hi:
                continue
            if lo > pos:
                pieces.append((False, pos, lo))
            pieces.append((True, lo, hi))
            pos = hi
        if not pieces:
            continue
        if pos < e:
            pieces.append((False, pos, e))
        run = t.getparent()
        if run.getparent().tag == W_INS:  # cannot nest revisions: replace text in place
            new_txt = "".join(
                "".join(b + m for b, m in pairs[base_idx[lo] : base_idx[hi]]) if ch else text[lo:hi]
                for ch, lo, hi in pieces
            )
            t.text = new_txt
            untracked += 1
            continue
        run = _isolate(t)
        rpr = run.find(qn("w:rPr"))
        parent = run.getparent()
        anchor = run
        for is_changed, lo, hi in pieces:
            if not is_changed:
                new_nodes = [_mk_run(rpr, "w:t", text[lo:hi])]
            else:
                d = _revision("w:del", ids, date)
                d.append(_mk_run(rpr, "w:delText", text[lo:hi]))
                i_ = _revision("w:ins", ids, date)
                piece = "".join(b + m for b, m in pairs[base_idx[lo] : base_idx[hi]])
                if piece:
                    i_.append(_mk_run(rpr, "w:t", piece))
                new_nodes = [d, i_] if piece else [d]
                revisions += 1
            for n in new_nodes:
                anchor.addnext(n)
                anchor = n
        parent.remove(run)
    return revisions, untracked


def process_docx_tracked(
    src: Path, dst: Path, pipeline: TashkeelPipeline, db_path: Path, include_comments: bool = False
) -> dict[str, Any]:
    src, dst = Path(src), Path(dst)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    if dst.resolve() == src.resolve():
        raise validation_error("target_path must differ from the source file")
    if not dst.parent.is_dir():
        raise validation_error("target directory does not exist", {"dir": str(dst.parent)})
    doc = open_source(src)
    parts = discover_parts(doc, include_comments)
    date = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    stats = {
        "paragraphs": 0,
        "revisions": 0,
        "untracked_in_existing_revisions": 0,
        "author": AUTHOR,
    }
    modified: dict[str, bytes] = {}
    roots: dict[str, Any] = {}
    kinds: dict[str, str] = {}
    with zipfile.ZipFile(src) as zin:
        for name, kind in parts:
            try:
                roots[name] = parse_xml(zin.read(name))
            except (KeyError, etree.XMLSyntaxError, zipfile.BadZipFile) as exc:
                raise docx_corrupt(f"{name}: {exc}") from exc
            kinds[name] = kind
    ids = _Ids(max([_max_id(r) for r in roots.values()] + [0]) + 100)
    conn = connect(db_path)
    try:
        for name, root in roots.items():
            changed_part = False
            for unit in list(iter_units(root, kinds[name])):
                if not unit.t_nodes or not has_arabic_letters(unit.text):
                    continue
                stats["paragraphs"] += 1
                out = pipeline.run_text(conn, unit.text)
                if not verify_mixed(unit.text, out):
                    continue
                n, u = track_unit(unit, out, ids, date)
                stats["revisions"] += n
                stats["untracked_in_existing_revisions"] += u
                changed_part |= bool(n or u)
            if changed_part:
                modified[name] = _serialize(root)
    finally:
        conn.close()
    _write_atomic(src, dst, modified)
    return stats


__all__ = ["AUTHOR", "W_DELTEXT", "W_R", "W_T", "process_docx_tracked", "track_unit"]
