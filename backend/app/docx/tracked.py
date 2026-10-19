"""«تصدير Word مع تعقّب التغييرات»: the editor's stored text against the ORIGINAL .docx, written
as real Word revisions (w:del + w:ins, author «مِزَاج») on top of the original formatting.

Every difference between the source paragraph and the editor line becomes one revision:
- a *proofreading* change (the base letters differ: hamza, spelling, ya, punctuation, edits) is
  one revision per changed word / mark;
- a *diacritization* change (same base letters, other marks) is one revision per word (default)
  or per letter cluster (`granularity="char"`).

Accept-all therefore gives the processed text and reject-all the original, paragraph by
paragraph. Each paragraph is verified that way right after it is written; one that does not
verify is left exactly as in the source (never a silent change). Paragraphs that cannot carry
revisions (code runs, existing revisions) are written without tracking and counted.
"""

from __future__ import annotations

import copy
import re
import zipfile
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal

from docx.oxml import parse_xml
from docx.oxml.ns import qn
from lxml import etree

from app.core.errors import docx_corrupt, validation_error
from app.docx.extractor import (
    PLACEHOLDER,
    W_BR,
    W_CR,
    W_DELTEXT,
    W_T,
    W_TAB,
    ParagraphUnit,
    discover_parts,
    iter_units,
    owner_paragraph,
)
from app.docx.service import _serialize, _write_atomic, open_source
from app.docx.stored import _drop_code_text, apply_text, plan
from app.engine.normalize import MARKS, WORD_RE, split_pairs, strip_marks
from app.io.trackchanges import AUTHOR, W_DEL, W_INS, _Ids, _isolate, _max_id, _mk_run, _revision

Scope = Literal["both", "proofread", "diacritics"]
Granularity = Literal["word", "char"]
SCOPES: tuple[str, ...] = ("both", "proofread", "diacritics")

_TOKEN_RE = re.compile(WORD_RE.pattern + r"|[\s\S]")
W_MOVE = (qn("w:moveFrom"), qn("w:moveTo"))


@dataclass(frozen=True)
class Change:
    a: int  # start in the (placeholder-free) old text
    b: int  # end; a == b is a pure insertion
    text: str  # what replaces old[a:b]
    kind: Literal["proof", "diac"]


def _tokens(text: str) -> list[tuple[str, int]]:
    return [(m.group(0), m.start()) for m in _TOKEN_RE.finditer(text)]


def _proof_text(old: str, new: str) -> str:
    """Proofreading-only: the corrected letters, with marks only when the source had marks."""
    return new if any(c in MARKS for c in old) else strip_marks(new)


def _cluster_changes(old_tok: str, new_tok: str, start: int) -> list[Change] | None:
    po, pn = split_pairs(old_tok, canon=False), split_pairs(new_tok, canon=False)
    if len(po) != len(pn) or "".join(b + m for b, m in po) != old_tok:
        return None
    out: list[Change] = []
    off = start
    for (bo, mo), (bn, mn) in zip(po, pn, strict=True):
        n = len(bo) + len(mo)
        if bo != bn:
            return None
        if mo != mn:
            out.append(Change(off, off + n, bn + mn, "diac"))
        off += n
    return out


def diff_changes(
    old: str, new: str, scope: Scope = "both", granularity: Granularity = "word"
) -> list[Change]:
    """Revisions that turn `old` into `new`, in old-text coordinates, restricted to `scope`."""
    if old == new:
        return []
    ot, nt = _tokens(old), _tokens(new)
    sm = SequenceMatcher(
        None, [strip_marks(t) for t, _ in ot], [strip_marks(t) for t, _ in nt], autojunk=False
    )
    out: list[Change] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            if scope == "proofread":
                continue
            for k in range(i2 - i1):
                (o, s), (n, _) = ot[i1 + k], nt[j1 + k]
                if o == n:
                    continue
                parts = _cluster_changes(o, n, s) if granularity == "char" else None
                out.extend(parts if parts is not None else [Change(s, s + len(o), n, "diac")])
            continue
        if scope == "diacritics":
            continue
        a = ot[i1][1] if i1 < len(ot) else len(old)
        b = ot[i2 - 1][1] + len(ot[i2 - 1][0]) if i2 > i1 else a
        o_txt, n_txt = old[a:b], "".join(t for t, _ in nt[j1:j2])
        if scope == "proofread":
            n_txt = _proof_text(o_txt, n_txt)
        if n_txt != o_txt:
            out.append(Change(a, b, n_txt, "proof"))
    return out


def splice(old: str, changes: Iterable[Change]) -> str:
    out, pos = [], 0
    for c in changes:
        out.append(old[pos : c.a])
        out.append(c.text)
        pos = c.b
    out.append(old[pos:])
    return "".join(out)


# --------------------------------------------------------------------------- paragraph text
def paragraph_text(p, accept: bool) -> str:
    """Visible text of paragraph `p` with every revision accepted (or rejected)."""
    out: list[str] = []
    for el in p.iter():
        if not isinstance(el.tag, str) or owner_paragraph(el) not in (p, None):
            continue
        if el.tag == W_T or el.tag == W_DELTEXT:
            anc, in_ins, in_del = el.getparent(), False, False
            while anc is not None and anc is not p:
                in_ins |= anc.tag == W_INS
                in_del |= anc.tag == W_DEL
                anc = anc.getparent()
            if el.tag == W_T and (accept or not in_ins):
                out.append(el.text or "")
            elif el.tag == W_DELTEXT and in_del and not accept:
                out.append(el.text or "")
        elif el.tag == W_TAB:
            out.append("\t")
        elif el.tag in (W_BR, W_CR):
            out.append("\n")
    return "".join(out)


def _has_revisions(p) -> bool:
    return any(el.tag in (W_INS, W_DEL, *W_MOVE) for el in p.iter())


# --------------------------------------------------------------------------- writing
def _spans(unit: ParagraphUnit) -> list[tuple[Any, int, int]]:
    spans: dict[int, list[int]] = {}
    order: list[Any] = []
    for i, node in enumerate(unit.owners):
        if node is None:
            continue
        k = id(node)
        if k not in spans:
            spans[k] = [i, i + 1]
            order.append(node)
        else:
            spans[k][1] = i + 1
    return [(t, spans[id(t)][0], spans[id(t)][1]) for t in order]


def _events(
    unit: ParagraphUnit, spans: list[tuple[Any, int, int]], changes: list[Change]
) -> dict[int, list[tuple[int, int, str, str]]] | None:
    """node id -> [(lo, hi, inserted text, kind)] in unit.text coordinates, or None when a
    change touches characters no run owns (tab, break, field, drawing)."""
    by_node: dict[int, list[tuple[int, int, str, str]]] = {}
    for c in changes:
        a, b = c.a, c.b
        if a == b:  # insertion: after the previous char's run, else before the next one's
            target = None
            for t, s, e in spans:
                if s < a <= e:
                    target = t
                    break
            if target is None:
                target = next((t for t, s, _e in spans if s == a), None)
            if target is None:
                return None
            by_node.setdefault(id(target), []).append((a, a, c.text, c.kind))
            continue
        covered = 0
        first = True
        for t, s, e in spans:
            lo, hi = max(a, s), min(b, e)
            if lo >= hi:
                continue
            covered += hi - lo
            by_node.setdefault(id(t), []).append((lo, hi, c.text if first else "", c.kind))
            first = False
        if covered != b - a:
            return None
    for ev in by_node.values():
        ev.sort(key=lambda x: (x[0], x[1]))
    return by_node


def _write_unit(unit: ParagraphUnit, changes: list[Change], ids: _Ids, date: str) -> bool:
    spans = _spans(unit)
    events = _events(unit, spans, changes)
    if events is None:
        return False
    for t, s, e in spans:
        ev = events.get(id(t))
        if not ev:
            continue
        text = t.text or ""
        run = _isolate(t)
        rpr = run.find(qn("w:rPr"))
        parent, anchor = run.getparent(), run
        nodes: list[Any] = []
        pos = s
        for lo, hi, ins_text, _kind in ev:
            if lo > pos:
                nodes.append(_mk_run(rpr, "w:t", text[pos - s : lo - s]))
            if hi > lo:
                d = _revision("w:del", ids, date)
                d.append(_mk_run(rpr, "w:delText", text[lo - s : hi - s]))
                nodes.append(d)
            if ins_text:
                i_ = _revision("w:ins", ids, date)
                i_.append(_mk_run(rpr, "w:t", ins_text))
                nodes.append(i_)
            pos = hi
        if pos < e:
            nodes.append(_mk_run(rpr, "w:t", text[pos - s :]))
        for n in nodes:
            anchor.addnext(n)
            anchor = n
        parent.remove(run)
    return True


def _track_unit(
    unit: ParagraphUnit,
    new_text: str,
    scope: Scope,
    granularity: Granularity,
    ids: _Ids,
    date: str,
) -> tuple[str, list[Change]]:
    """(outcome, changes). outcome: same | tracked | untracked | skipped."""
    keep = [i for i, c in enumerate(unit.text) if c != PLACEHOLDER]
    old = "".join(unit.text[i] for i in keep)
    if unit.skipped_code_runs:
        dropped = _drop_code_text(unit, new_text)
        if dropped is None:
            return "skipped", []
        new_text = dropped
    changes = diff_changes(old, new_text, scope, granularity)
    if not changes:
        return "same", []
    expected = splice(old, changes)
    if unit.skipped_code_runs or _has_revisions(unit.p) or not unit.t_nodes:
        # cannot carry nested/extra revisions: written plainly, counted as untracked
        return ("untracked" if apply_text(unit, expected) else "skipped"), changes
    n = len(keep)
    mapped: list[Change] = []
    for c in changes:
        a = keep[c.a] if c.a < n else len(unit.text)
        b = keep[c.b - 1] + 1 if c.b > c.a else a
        mapped.append(Change(a, b, c.text, c.kind))
    snapshot = copy.deepcopy(unit.p)
    if _write_unit(unit, mapped, ids, date) and (
        paragraph_text(unit.p, True) == expected and paragraph_text(unit.p, False) == old
    ):
        return "tracked", changes
    unit.p.getparent().replace(unit.p, snapshot)  # verification failed: back to the source
    return "skipped", []


def process_docx_edits_tracked(
    src: Path,
    dst: Path,
    stored: str,
    scope: Scope = "both",
    granularity: Granularity = "word",
    date: str | None = None,
) -> dict[str, Any]:
    """Blocking. Writes `dst` = `src` with the differences to `stored` as tracked changes."""
    src, dst = Path(src), Path(dst)
    if scope not in SCOPES:
        raise validation_error("scope must be both, proofread or diacritics")
    if not src.is_file():
        raise FileNotFoundError(str(src))
    if dst.resolve() == src.resolve():
        raise validation_error("target_path must differ from the source file")
    if not dst.parent.is_dir():
        raise validation_error("target directory does not exist", {"dir": str(dst.parent)})
    doc = open_source(src)
    body_name = doc.part.partname.lstrip("/")
    parts = discover_parts(doc, False)
    roots: dict[str, Any] = {}
    with zipfile.ZipFile(src) as zin:
        for name, _kind in parts:
            try:
                roots[name] = parse_xml(zin.read(name))
            except (KeyError, etree.XMLSyntaxError, zipfile.BadZipFile) as exc:
                raise docx_corrupt(f"{name}: {exc}") from exc
    ids = _Ids(max([_max_id(r) for r in roots.values()] + [0]) + 100)
    date = date or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    root = roots[body_name]
    units = list(iter_units(root, "body"))
    texts, adds = plan(units, stored)
    stats: dict[str, Any] = {
        "scope": scope,
        "granularity": granularity,
        "author": AUTHOR,
        "revisions": 0,
        "proofread_revisions": 0,
        "diacritic_revisions": 0,
        "tracked_paragraphs": 0,
        "untracked_paragraphs": 0,
        "skipped_paragraphs": 0,
        # editor lines with no source paragraph are not written (never a silent addition)
        "unmatched_lines": sum(len(v) for v in adds.values()),
    }
    touched = False
    for ui, new_text in texts.items():
        unit = units[ui]
        outcome, changes = _track_unit(unit, new_text, scope, granularity, ids, date)
        if outcome == "tracked":
            stats["tracked_paragraphs"] += 1
            stats["proofread_revisions"] += sum(c.kind == "proof" for c in changes)
            stats["diacritic_revisions"] += sum(c.kind == "diac" for c in changes)
            touched = True
        elif outcome == "untracked":
            stats["untracked_paragraphs"] += 1
            touched = True
        elif outcome == "skipped":
            stats["skipped_paragraphs"] += 1
    stats["revisions"] = stats["proofread_revisions"] + stats["diacritic_revisions"]
    modified = {body_name: _serialize(root)} if touched else {}
    _write_atomic(src, dst, modified)
    validate_tracked_docx(dst)
    return stats


# --------------------------------------------------------------------------- validation
def validate_tracked_docx(path: Path) -> dict[str, int]:
    """Well-formedness and revision placement of a produced file. Raises a MizajError when the
    XML is malformed, ids repeat, revisions are nested, text sits in the wrong element, or a
    revision lacks author/date. Returns the counts."""
    ins = dele = 0
    seen: set[str] = set()
    with zipfile.ZipFile(path) as z:
        if z.testzip() is not None:
            raise docx_corrupt("zip")
        try:
            root = etree.fromstring(z.read("word/document.xml"))
        except etree.XMLSyntaxError as exc:
            raise docx_corrupt(f"word/document.xml: {exc}") from exc
    for el in root.iter(W_INS, W_DEL):
        rid = el.get(qn("w:id"))
        if not rid or rid in seen or not el.get(qn("w:author")) or not el.get(qn("w:date")):
            raise docx_corrupt("revision without a unique id / author / date")
        seen.add(rid)
        if any(a.tag in (W_INS, W_DEL) for a in el.iterancestors()):
            raise docx_corrupt("nested revision")
        if el.tag == W_INS:
            ins += 1
        else:
            dele += 1
    for t in root.iter(W_T):
        if any(a.tag == W_DEL for a in t.iterancestors()):
            raise docx_corrupt("w:t inside w:del (must be w:delText)")
    for t in root.iter(W_DELTEXT):
        if not any(a.tag == W_DEL for a in t.iterancestors()):
            raise docx_corrupt("w:delText outside w:del")
    return {"ins": ins, "del": dele}


__all__ = [
    "SCOPES",
    "Change",
    "diff_changes",
    "paragraph_text",
    "process_docx_edits_tracked",
    "splice",
    "validate_tracked_docx",
]
