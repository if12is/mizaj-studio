"""The editor's stored text applied to the original .docx, run by run.

ONE code path (`apply_stored`) turns the source body XML plus the editor's flow text into the
edited tree. Both the DOCX export (`service.process_docx`) and the page view
(`render.render_docx`) call it, so the page view looks exactly like the exported file.

The editor holds the document as flow text (one line per source paragraph, as produced by
`service.extract_plain_text`). Lines are aligned with the source paragraphs by their mark-less
text, so added or removed lines cannot shift the rest of the document. A matched line always
wins over the original: same letters -> marks only; different letters -> a letter diff inside
the paragraph's own runs (a heavily rewritten paragraph is written into its first run's
formatting). Editor lines with no source paragraph become new paragraphs (formatted like the
paragraph before them); source paragraphs whose line was deleted are removed.
"""

from __future__ import annotations

import copy
from collections.abc import Sequence
from difflib import SequenceMatcher

from docx.oxml.ns import qn
from lxml import etree

from app.docx.extractor import (
    PLACEHOLDER,
    W_P,
    W_R,
    W_RPR,
    W_T,
    ParagraphUnit,
    apply_unit,
    apply_unit_edit,
    iter_units,
    owner_paragraph,
)
from app.docx.mixed import is_code_run
from app.engine.normalize import strip_marks

W_PPR = qn("w:pPr")
W_TC = qn("w:tc")
W_SECTPR = qn("w:sectPr")
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
MATCH_RATIO = 0.5  # pairing of unequal edited blocks: a line must resemble its source line


def _plain(unit: ParagraphUnit) -> str:
    from app.docx.service import _plain as plain  # lazy: circular import

    return plain(unit)


def _split(stored: str) -> list[str]:
    return stored.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _pair_block(old: list[str], new: list[str]) -> dict[int, int]:
    """old index -> new index inside one replaced block (both mark-less)."""
    if len(old) == len(new):
        return {k: k for k in range(len(old))}
    out: dict[int, int] = {}
    nxt = 0
    for a, text in enumerate(old):
        best, best_r = -1, MATCH_RATIO
        for b in range(nxt, len(new)):
            r = SequenceMatcher(None, text, new[b], autojunk=False).ratio()
            if r >= best_r:
                best, best_r = b, r
        if best >= 0:
            out[a] = best
            nxt = best + 1
    return out


def plan(
    units: Sequence[ParagraphUnit], stored: str
) -> tuple[dict[int, str], dict[int, list[str]]]:
    """(unit index -> its new text, unit index (-1 = before the first) -> editor lines to add
    after it). A unit missing from the first map had every line deleted in the editor."""
    orig: list[tuple[int, int, str]] = []
    counts: dict[int, int] = {}
    for ui, u in enumerate(units):
        if u.category not in ("body", "sdt"):
            continue
        lines = _plain(u).split("\n")
        counts[ui] = len(lines)
        for si, line in enumerate(lines):
            orig.append((ui, si, strip_marks(line)))
    new = _split(stored)
    new_plain = [strip_marks(x) for x in new]
    sm = SequenceMatcher(None, [o[2] for o in orig], new_plain, autojunk=False)
    mapped: dict[tuple[int, int], str] = {}
    adds: dict[int, list[str]] = {}

    def add(anchor: int, line: str) -> None:
        if line.strip():  # blank editor lines are spacing, not paragraphs
            adds.setdefault(anchor, []).append(line)

    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        anchor = orig[i1 - 1][0] if i1 > 0 else -1
        if tag == "equal":
            for k in range(i2 - i1):
                mapped[orig[i1 + k][0], orig[i1 + k][1]] = new[j1 + k]
        elif tag == "replace":
            pairs = _pair_block(
                [o[2] for o in orig[i1:i2]], new_plain[j1:j2]
            )
            back = {b: a for a, b in pairs.items()}
            for b in range(j2 - j1):
                if b in back:
                    ui, si, _ = orig[i1 + back[b]]
                    mapped[ui, si] = new[j1 + b]
                    anchor = ui
                else:
                    add(anchor, new[j1 + b])
        elif tag == "insert":
            for j in range(j1, j2):
                add(anchor, new[j])
    out: dict[int, str] = {}
    for ui, n in counts.items():
        if any((ui, si) in mapped for si in range(n)):
            out[ui] = "\n".join(mapped.get((ui, si), "") for si in range(n))
    return out, adds


def _drop_code_text(unit: ParagraphUnit, text: str) -> str | None:
    pos = 0
    for r in unit.p.iter(W_R):
        if owner_paragraph(r) is not unit.p or not is_code_run(r):
            continue
        code = "".join(t.text or "" for t in r if t.tag == W_T)
        if not code:
            continue
        at = text.find(code, pos)
        if at < 0:
            return None
        text = text[:at] + text[at + len(code) :]
        pos = at
    return text


def apply_text(unit: ParagraphUnit, text: str) -> str | None:
    """Write `text` into the paragraph. Returns "marks" (same letters, marks applied),
    "edited" (letters differ: user edit), or None if the paragraph cannot take it."""
    from app.docx.render import _lift  # lazy: render imports service lazily too

    if not unit.t_nodes:
        return None
    if unit.skipped_code_runs:  # code / Latin runs are never touched: cut them out of the line
        text = _drop_code_text(unit, text)
        if text is None:
            return None  # the editor changed the code text itself: keep the original run
    lifted = _lift(unit.text, text)
    if lifted is not None:
        try:
            apply_unit(unit, lifted)
            return "marks"
        except ValueError:
            pass
    try:
        apply_unit_edit(unit, text)
    except ValueError:
        first, *rest = unit.t_nodes  # nothing to diff against: all text into the first run
        first.text = text
        first.set(XML_SPACE, "preserve")
        for t in rest:
            t.text = ""
    return "edited"


def _removable(unit: ParagraphUnit) -> bool:
    p = unit.p
    if PLACEHOLDER in unit.text or unit.skipped_code_runs or not _plain(unit).strip():
        return False
    ppr = p.find(W_PPR)
    if ppr is not None and ppr.find(W_SECTPR) is not None:
        return False
    parent = p.getparent()
    if parent is None:
        return False
    if parent.tag == W_TC and sum(1 for c in parent if c.tag == W_P) == 1:
        return False
    return True


def _new_paragraph(model: ParagraphUnit | None, text: str):
    p = etree.Element(W_P)
    r = etree.SubElement(p, W_R)
    if model is not None:
        ppr = model.p.find(W_PPR)
        if ppr is not None:
            ppr = copy.deepcopy(ppr)
            for bad in ppr.findall(W_SECTPR):
                ppr.remove(bad)
            p.insert(0, ppr)
        run = next((x for x in model.p.iter(W_R) if x.find(W_T) is not None), None)
        rpr = run.find(W_RPR) if run is not None else None
        if rpr is not None:
            r.append(copy.deepcopy(rpr))
    t = etree.SubElement(r, W_T)
    t.text = text
    t.set(XML_SPACE, "preserve")
    return p


def apply_stored(root, stored: str) -> dict[str, int]:
    """Edit the body tree `root` in place so it carries the editor text `stored`.

    Returns counts: `applied` (paragraphs written from the editor), `edited` (of those, with
    different letters), `added` (new paragraphs), `removed`, `kept` (paragraphs the editor text
    could not be written into: code runs / no text)."""
    units = list(iter_units(root, "body"))
    stats = {"applied": 0, "edited": 0, "added": 0, "removed": 0, "kept": 0}
    texts, adds = plan(units, stored)
    flow = [u for u in units if u.category in ("body", "sdt")]
    body = root.find(qn("w:body"))
    for anchor, lines in adds.items():  # first: anchors may be paragraphs removed below
        prev = units[anchor].p if anchor >= 0 else None
        for line in lines:
            if flow:
                np_ = _new_paragraph(units[anchor] if anchor >= 0 else flow[0], line)
                if prev is not None:
                    prev.addnext(np_)
                else:
                    flow[0].p.addprevious(np_)
            elif body is not None:  # no source paragraph at all: plain paragraphs at the end
                np_ = _new_paragraph(None, line)
                sect = body.find(W_SECTPR)
                sect.addprevious(np_) if sect is not None else body.append(np_)
            else:
                continue
            prev = np_ if prev is not None or not flow else None
            stats["added"] += 1
    for ui, unit in enumerate(units):
        if unit.category not in ("body", "sdt"):
            continue
        if ui not in texts:
            if _removable(unit):
                unit.p.getparent().remove(unit.p)
                stats["removed"] += 1
            else:
                for t in unit.t_nodes:
                    t.text = ""
            continue
        how = apply_text(unit, texts[ui])
        if how is None:
            stats["kept"] += 1
            continue
        stats["applied"] += 1
        stats["edited"] += how == "edited"
    return stats
