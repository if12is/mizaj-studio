"""RunStyleSignature and the logical "segment" view over runs.

Approach (no XML mutation): the plan's problem is that Word splits one Arabic word across
several `w:r` elements. Instead of physically merging runs (which would rewrite markup and
risk losing rsids/formatting), we build a *logical* view:

* `run_signature(run)` is the exact 7-tuple of Task 3.1.1.
* `segments(parent)` groups adjacent sibling `w:r` that contain only `w:t` (plus `w:rPr`) and
  have identical signatures. Runs with fldChar / instrText / drawing / tab / br /
  footnoteReference / ... are never grouped (they are their own barrier).
* The paragraph text handed to the engine is the concatenation of ALL runs in order
  (segments only describe where formatting is uniform). After diacritization, text is
  redistributed into the original `w:t` nodes by *ownership of base letters*: every base
  letter keeps its original `w:t`, and its diacritics are appended right after it. A word that
  straddles runs with DIFFERENT formatting therefore still keeps each letter's formatting.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from docx.oxml.ns import qn
from docx.text.run import Run

W_R = qn("w:r")
W_T = qn("w:t")
W_RPR = qn("w:rPr")

RunStyleSignature = tuple  # (bold, italic, underline, color_rgb, font_name, font_size, rtl)


def run_signature(run: Run) -> RunStyleSignature:
    color = run.font.color
    return (
        run.bold,
        run.italic,
        run.underline,
        color.rgb if color else None,
        run.font.name,
        run.font.size,
        run.font.rtl,
    )


def is_text_only_run(r) -> bool:
    """True if the run's only content (besides rPr) is w:t elements."""
    kids = [c for c in r if c.tag != W_RPR]
    return bool(kids) and all(c.tag == W_T for c in kids)


@dataclass
class Segment:
    signature: RunStyleSignature
    runs: list = field(default_factory=list)

    @property
    def t_nodes(self) -> list:
        return [t for r in self.runs for t in r if t.tag == W_T]


def segments(parent) -> list[Segment]:
    """Logical segments over the direct `w:r` children of `parent` (read-only)."""
    out: list[Segment] = []
    current: Segment | None = None
    for child in parent:
        if child.tag != W_R:
            current = None  # a non-run sibling (bookmark, field, hyperlink...) ends the group
            continue
        if not is_text_only_run(child):
            current = None
            continue
        sig = run_signature(Run(child, None))
        if current is not None and current.signature == sig:
            current.runs.append(child)
        else:
            current = Segment(sig, [child])
            out.append(current)
    return out
