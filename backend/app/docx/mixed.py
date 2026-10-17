"""Mixed Arabic / non-Arabic handling and code-font detection."""

from __future__ import annotations

import re

from docx.oxml.ns import qn

ARABIC_RE = re.compile("[؀-ۿ]+")
# lower-case; matched against rFonts ascii / hAnsi / cs / eastAsia
CODE_FONTS = frozenset(
    {
        "courier new",
        "consolas",
        "fira code",
        "courier",
        "lucida console",
        "monaco",
        "menlo",
        "source code pro",
        "cascadia code",
        "jetbrains mono",
    }
)
_FONT_ATTRS = ("ascii", "hAnsi", "cs", "eastAsia")


def tokenize(text: str) -> list[tuple[bool, str]]:
    """Split into (is_arabic, token) pairs; concatenating the tokens gives `text` exactly."""
    out: list[tuple[bool, str]] = []
    pos = 0
    for m in ARABIC_RE.finditer(text):
        if m.start() > pos:
            out.append((False, text[pos : m.start()]))
        out.append((True, m.group(0)))
        pos = m.end()
    if pos < len(text):
        out.append((False, text[pos:]))
    return out


def verify_mixed(original: str, diacritized: str) -> bool:
    """Non-Arabic tokens byte-identical; Arabic tokens equal once diacritics are stripped."""
    from app.engine.normalize import strip_marks

    a, b = tokenize(original), tokenize(diacritized)
    if len(a) != len(b):
        return False
    for (arab_a, ta), (arab_b, tb) in zip(a, b, strict=True):
        if arab_a != arab_b:
            return False
        if arab_a:
            if strip_marks(ta) != strip_marks(tb):
                return False
        elif ta != tb:
            return False
    return True


def is_code_run(r) -> bool:
    """True if the `w:r` uses a programming font (case-insensitive, any rFonts slot)."""
    rpr = r.find(qn("w:rPr"))
    if rpr is None:
        return False
    fonts = rpr.find(qn("w:rFonts"))
    if fonts is None:
        return False
    return any((fonts.get(qn(f"w:{a}")) or "").strip().lower() in CODE_FONTS for a in _FONT_ATTRS)
