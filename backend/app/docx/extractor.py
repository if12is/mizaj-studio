"""Paragraph-level extraction over every text-bearing part of a .docx.

Each `w:p` becomes one `ParagraphUnit`: its visible text as ONE string (so the engine has
sentence context) plus an ownership map from every character back to the `w:t` node it came
from. Non-text content (tabs, breaks, drawings, field characters, footnote references, code
runs) appears as a placeholder character that no node owns, so it is never rewritten.
`w:instrText` / `w:delText` are never read or written.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field

from docx.oxml.ns import qn

from app.docx.mixed import is_code_run
from app.docx.signature import segments
from app.engine.normalize import MARKS, split_pairs

W_P = qn("w:p")
W_R = qn("w:r")
W_T = qn("w:t")
W_RPR = qn("w:rPr")
W_TAB = qn("w:tab")
W_BR = qn("w:br")
W_CR = qn("w:cr")
W_INSTR = qn("w:instrText")
W_DELTEXT = qn("w:delText")
W_TXBX = qn("w:txbxContent")
W_SDTCONTENT = qn("w:sdtContent")
PLACEHOLDER = "￼"

REL_KINDS = {
    "/header": "headers",
    "/footer": "footers",
    "/footnotes": "footnotes",
    "/endnotes": "endnotes",
    "/comments": "comments",
}


@dataclass
class ParagraphUnit:
    p: object
    category: str
    text: str
    owners: list  # per char: owning w:t element or None
    skipped_code_runs: int = 0
    segment_count: int = 0
    t_nodes: list = field(default_factory=list)

    def plain_text(self) -> str:
        return self.text.replace(PLACEHOLDER, "")


def discover_parts(doc, include_comments: bool) -> list[tuple[str, str]]:
    """(zip member name, kind) for the document body and every referenced text part,
    deduplicated by part name (headers/footers shared between sections appear once)."""
    parts = [(doc.part.partname.lstrip("/"), "body")]
    seen = {parts[0][0]}
    for rel in doc.part.rels.values():
        if rel.is_external:
            continue
        kind = next((k for suffix, k in REL_KINDS.items() if rel.reltype.endswith(suffix)), None)
        if kind is None or (kind == "comments" and not include_comments):
            continue
        name = str(rel.target_part.partname).lstrip("/")
        if name not in seen:
            seen.add(name)
            parts.append((name, kind))
    return parts


def owner_paragraph(r):
    node = r.getparent()
    while node is not None and node.tag != W_P:
        node = node.getparent()
    return node


def _category(p, part_kind: str) -> str:
    anc = p.getparent()
    in_sdt = False
    while anc is not None:
        if anc.tag == W_TXBX:
            return "textboxes"
        if anc.tag == W_SDTCONTENT:
            in_sdt = True
        anc = anc.getparent()
    return "sdt" if in_sdt else part_kind


def build_unit(p, part_kind: str) -> ParagraphUnit | None:
    chars: list[str] = []
    owners: list = []
    t_nodes: list = []
    code_runs = 0
    for r in p.iter(W_R):
        if owner_paragraph(r) is not p:
            continue  # belongs to a nested paragraph (text box); handled as its own unit
        if is_code_run(r):
            if any(c.tag == W_T and c.text for c in r):
                code_runs += 1
                chars.append(PLACEHOLDER)
                owners.append(None)
            continue
        for c in r:
            if c.tag == W_RPR or c.tag in (W_INSTR, W_DELTEXT):
                continue
            if c.tag == W_T:
                txt = c.text or ""
                if txt:
                    t_nodes.append(c)
                for ch in txt:
                    chars.append(ch)
                    owners.append(c)
            elif c.tag == W_TAB:
                chars.append("\t")
                owners.append(None)
            elif c.tag in (W_BR, W_CR):
                chars.append("\n")
                owners.append(None)
            else:
                chars.append(PLACEHOLDER)
                owners.append(None)
    if not t_nodes and not code_runs:
        return None
    seg_count = sum(len(segments(parent)) for parent in {r.getparent() for r in p.iter(W_R)})
    return ParagraphUnit(
        p, _category(p, part_kind), "".join(chars), owners, code_runs, seg_count, t_nodes
    )


def iter_units(root, part_kind: str) -> Iterator[ParagraphUnit]:
    """All paragraphs in document order: body, nested tables (merged cells appear once),
    text boxes (both mc:Choice and mc:Fallback copies), content controls."""
    for p in root.iter(W_P):
        unit = build_unit(p, part_kind)
        if unit is not None:
            yield unit


def apply_unit(unit: ParagraphUnit, diacritized: str) -> tuple[bool, int]:
    """Redistribute `diacritized` into the unit's w:t nodes by base-letter ownership.

    Returns (changed, dropped_orphan_marks). Raises ValueError if the text does not align.
    """
    text = unit.text
    bases = [i for i, c in enumerate(text) if c not in MARKS]
    pairs = split_pairs(diacritized, canon=False)
    if len(pairs) != len(bases) or any(pairs[k][0] != text[i] for k, i in enumerate(bases)):
        raise ValueError("diacritized text does not align with the source paragraph")
    pieces: dict[int, list[str]] = {id(t): [] for t in unit.t_nodes}
    dropped = 0
    for k, i in enumerate(bases):
        node = unit.owners[i]
        base, marks = pairs[k]
        if node is None:
            dropped += len(marks)
        else:
            pieces[id(node)].append(base + marks)
    changed = False
    for t in unit.t_nodes:
        new = "".join(pieces[id(t)])
        if new != (t.text or ""):
            t.text = new
            changed = True
    return changed, dropped
