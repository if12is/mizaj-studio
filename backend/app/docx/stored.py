"""Export of the editor's stored text into the original .docx, run by run.

The editor holds the document as flow text (one line per source paragraph, as produced by
`service.extract_plain_text`). When the user edited that text (word inspector, manual marks,
accepted proofreading suggestions), the export must carry those edits instead of re-running
the engine. Lines are aligned with the source paragraphs by their mark-less text, so added
or removed lines in the editor cannot shift the rest of the document.
"""

from __future__ import annotations

from collections.abc import Sequence
from difflib import SequenceMatcher

from app.docx.extractor import ParagraphUnit, apply_unit, apply_unit_edit
from app.engine.normalize import strip_marks

MIN_EDIT_RATIO = 0.5  # a changed line must still resemble its source paragraph


def _plain(unit: ParagraphUnit) -> str:
    from app.docx.service import _plain as plain  # lazy: circular import

    return plain(unit)


def plan(units: Sequence[ParagraphUnit], stored: str) -> dict[int, str]:
    """unit index -> the stored text for that paragraph, for every flow-text paragraph whose
    lines could be matched; the others are left out (the caller falls back to the engine)."""
    orig: list[tuple[int, int, str]] = []
    counts: dict[int, int] = {}
    for ui, u in enumerate(units):
        if u.category not in ("body", "sdt"):
            continue
        lines = _plain(u).split("\n")
        counts[ui] = len(lines)
        for si, line in enumerate(lines):
            orig.append((ui, si, strip_marks(line)))
    new = stored.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    sm = SequenceMatcher(None, [o[2] for o in orig], [strip_marks(x) for x in new], autojunk=False)
    mapped: dict[tuple[int, int], str] = {}
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            for k in range(i2 - i1):
                mapped[orig[i1 + k][0], orig[i1 + k][1]] = new[j1 + k]
        elif tag == "replace":
            for k in range(min(i2 - i1, j2 - j1)):
                a, b = orig[i1 + k][2], strip_marks(new[j1 + k])
                if SequenceMatcher(None, a, b, autojunk=False).ratio() >= MIN_EDIT_RATIO:
                    mapped[orig[i1 + k][0], orig[i1 + k][1]] = new[j1 + k]
    out: dict[int, str] = {}
    for ui, n in counts.items():
        if all((ui, si) in mapped for si in range(n)):
            out[ui] = "\n".join(mapped[ui, si] for si in range(n))
    return out


def apply_text(unit: ParagraphUnit, text: str) -> str | None:
    """Write `text` into the paragraph. Returns "marks" (same letters, marks applied),
    "edited" (letters differ: user edit), or None if the paragraph cannot take it."""
    from app.docx.render import _lift  # lazy: render imports service lazily too

    if unit.skipped_code_runs or not unit.t_nodes:
        return None
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
        return None
    return "edited"
