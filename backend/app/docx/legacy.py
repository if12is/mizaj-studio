"""Legacy binary Word (.doc) support without Word/LibreOffice: extract the main-document text
from the OLE2 container (piece table) and write it into a fresh .docx."""
from __future__ import annotations

import re
import struct
from pathlib import Path

_CTRL = re.compile(r"[\x00-\x08\x0e-\x1f]")


def _field_clean(t: str) -> str:
    """Drop field instructions (0x13 code 0x14 result 0x15) keeping the visible result."""
    out: list[str] = []
    stack: list[bool] = []  # True while inside the instruction part
    for ch in t:
        if ch == "\x13":
            stack.append(True)
        elif ch == "\x14" and stack:
            stack[-1] = False
        elif ch == "\x15" and stack:
            stack.pop()
        elif not any(stack):
            out.append(ch)
    return "".join(out)


def extract_text(path: Path) -> str:
    import olefile

    ole = olefile.OleFileIO(str(path))
    try:
        wd = ole.openstream("WordDocument").read()
        if len(wd) < 0x1AA or struct.unpack_from("<H", wd, 0)[0] != 0xA5EC:
            raise ValueError("not a Word 97+ document")
        flags = struct.unpack_from("<H", wd, 0x0A)[0]
        if flags & 0x0100:
            raise ValueError("encrypted document")
        tbl = ole.openstream("1Table" if flags & 0x0200 else "0Table").read()
    finally:
        ole.close()
    ccp_text = struct.unpack_from("<i", wd, 0x4C)[0]
    fc_clx, lcb_clx = struct.unpack_from("<II", wd, 0x1A2)
    clx = tbl[fc_clx : fc_clx + lcb_clx]
    i = 0
    while i < len(clx) and clx[i] == 1:  # skip Prc blocks
        i += 3 + struct.unpack_from("<H", clx, i + 1)[0]
    if i >= len(clx) or clx[i] != 2:
        raise ValueError("no piece table")
    lcb = struct.unpack_from("<I", clx, i + 1)[0]
    plc = clx[i + 5 : i + 5 + lcb]
    n = (lcb - 4) // 12
    cps = struct.unpack_from(f"<{n + 1}I", plc, 0)
    parts: list[str] = []
    for k in range(n):
        start, end = cps[k], min(cps[k + 1], ccp_text)
        if end <= start:
            continue
        fc = struct.unpack_from("<I", plc, 4 * (n + 1) + 8 * k + 2)[0]
        cnt = end - start
        if fc & 0x40000000:
            off = (fc & 0x3FFFFFFF) // 2
            parts.append(wd[off : off + cnt].decode("cp1252", "replace"))
        else:
            parts.append(wd[fc : fc + cnt * 2].decode("utf-16-le", "replace"))
    text = _field_clean("".join(parts))
    text = text.replace("\r\x07", "\t").replace("\x07", "\t")
    text = text.replace("\r", "\n").replace("\x0b", "\n").replace("\x0c", "\n")
    return _CTRL.sub("", text).replace("\xa0", " ").strip("\n")


_ARABIC = re.compile(r"[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]")
_AR_FONT = "Simplified Arabic"


def doc_to_docx(src: Path, dst: Path) -> None:
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    d = Document()
    for line in extract_text(src).split("\n"):
        p = d.add_paragraph(line.rstrip("\t"))
        if _ARABIC.search(line):
            ppr = p._p.get_or_add_pPr()
            ppr.append(OxmlElement("w:bidi"))
            # with w:bidi, "left" means the leading (right) edge in Word
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            for r in p.runs:
                rpr = r._r.get_or_add_rPr()
                fonts = OxmlElement("w:rFonts")
                for a in ("w:ascii", "w:hAnsi", "w:cs"):
                    fonts.set(qn(a), _AR_FONT)
                rpr.append(fonts)
                rpr.append(OxmlElement("w:rtl"))
        else:
            p.alignment = WD_ALIGN_PARAGRAPH.LEFT
    d.save(str(dst))
