# ruff: noqa: E501
"""TXT / Markdown / SRT / EPUB / PDF import and export (7.3.4).

All diacritization goes through `TashkeelPipeline.run_text`; syntax (Markdown markers, SRT timing,
HTML tags) is masked with U+FFFC placeholders so it is never rewritten.
"""

from __future__ import annotations

import codecs
import re
import unicodedata
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from lxml import etree

from app.core import security
from app.core.errors import MizajError, validation_error
from app.engine.normalize import MARKS, has_arabic_letters, split_pairs, strip_marks

PH = "￼"
Diacritize = Callable[[str], str]  # text -> diacritized text (same base letters)
MAX_IMPORT_BYTES = 200 * 1024 * 1024


def bad_input(reason: str, path: Path | None = None) -> MizajError:
    return MizajError(
        "ERR_FILE_INVALID", 422, "الملف غير صالح أو تالف.", f"Invalid input file: {reason}",
        {"reason": reason, "path": str(path) if path else None},
    )  # fmt: skip


# ---------------------------------------------------------------- encoding
def decode_bytes(data: bytes) -> tuple[str, str]:
    """(text, encoding) with detection: BOMs, UTF-16 without BOM (NUL pattern), UTF-8, cp1256."""
    if data.startswith(codecs.BOM_UTF8):
        return data[3:].decode("utf-8", "replace"), "utf-8-sig"
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        return data.decode("utf-16", "replace"), "utf-16"
    if data:
        sample = data[:4096]
        if len(data) % 2 == 0 and len(sample) >= 4:
            hi_le, hi_be = sample[1::2], sample[0::2]
            for enc, hi in (("utf-16-le", hi_le), ("utf-16-be", hi_be)):
                if hi.count(6) > len(hi) * 0.5:  # U+06xx: Arabic block high byte
                    try:
                        return data.decode(enc), enc
                    except UnicodeDecodeError:
                        pass
        if sample.count(b"\x00") > len(sample) // 4:
            enc = (
                "utf-16-le"
                if sample[1::2].count(b"\x00") > sample[0::2].count(b"\x00")
                else "utf-16-be"
            )
            try:
                return data.decode(enc), enc
            except UnicodeDecodeError:
                pass
    try:
        return data.decode("utf-8"), "utf-8"
    except UnicodeDecodeError:
        return data.decode("cp1256", "replace"), "cp1256"


def read_text_file(path: Path) -> tuple[str, str]:
    path = Path(path)
    if path.stat().st_size > MAX_IMPORT_BYTES:
        raise bad_input("file too large", path)
    return decode_bytes(path.read_bytes())


def write_text_file(path: Path, text: str, bom: bool = False) -> None:
    path = Path(path)
    tmp = path.with_name(f".~mizaj_tmp.{path.name}")
    tmp.write_bytes((codecs.BOM_UTF8 if bom else b"") + text.encode("utf-8"))
    tmp.replace(path)


# ---------------------------------------------------------------- masked diacritization
def diacritize_masked(text: str, mask: re.Pattern[str], fn: Diacritize) -> str:
    """Replace `mask` matches by U+FFFC, diacritize, restore. Falls back to `text` on mismatch."""
    if not has_arabic_letters(text):
        return text
    saved: list[str] = []

    def sub(m: re.Match[str]) -> str:
        saved.append(m.group(0))
        return PH

    masked = mask.sub(sub, text)
    out = fn(masked)
    if out.count(PH) != len(saved) or strip_marks(out) != strip_marks(masked):
        return text
    it = iter(saved)
    return re.sub(PH, lambda _m: next(it), out)


_MD_INLINE = re.compile(
    r"`[^`\n]*`"  # inline code
    r"|!?\[[^\]\n]*\]\([^)\n]*\)"  # links/images (text part is masked too: safe default)
    r"|<[^>\n]+>"  # html tags
    r"|https?://\S+"
    r"|\[[^\]\n]*\]:\s*\S+"  # reference definitions
    r"|(?<![\w])[*_~]{1,3}(?=\S)|(?<=\S)[*_~]{1,3}(?![\w])"  # emphasis markers
)
_MD_PREFIX = re.compile(r"^(\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?)")
_FENCE = re.compile(r"^\s{0,3}(```|~~~)")


def diacritize_markdown(text: str, fn: Diacritize) -> str:
    out: list[str] = []
    in_fence = False
    in_front = False
    lines = text.split("\n")
    for i, line in enumerate(lines):
        if i == 0 and line.strip() == "---":
            in_front = True
            out.append(line)
            continue
        if in_front:
            if line.strip() in ("---", "..."):
                in_front = False
            out.append(line)
            continue
        if _FENCE.match(line):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence or line.startswith("    ") and not line.strip().startswith(("-", "*")):
            out.append(line)
            continue
        cr = "\r" if line.endswith("\r") else ""
        body = line[:-1] if cr else line
        prefix = _MD_PREFIX.match(body).group(0)  # type: ignore[union-attr]
        rest = body[len(prefix) :]
        out.append(prefix + diacritize_masked(rest, _MD_INLINE, fn) + cr)
    return "\n".join(out)


_SRT_TIME = re.compile(r"^\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}")
_SRT_TAGS = re.compile(r"<[^>\n]+>|\{\\[^}\n]*\}")


def diacritize_srt(text: str, fn: Diacritize) -> str:
    lines = text.split("\n")
    out: list[str] = []
    in_cue_text = False
    for line in lines:
        s = line.strip()
        if _SRT_TIME.match(line):
            in_cue_text = True
            out.append(line)
        elif not s:
            in_cue_text = False
            out.append(line)
        elif in_cue_text:
            cr = "\r" if line.endswith("\r") else ""
            body = line[:-1] if cr else line
            out.append(diacritize_masked(body, _SRT_TAGS, fn) + cr)
        else:  # cue index
            out.append(line)
    return "\n".join(out)


# ---------------------------------------------------------------- EPUB
XHTML_EXT = (".xhtml", ".html", ".htm")
_SKIP = {"script", "style", "code", "pre", "kbd", "samp", "svg", "math", "head"}
_BLOCK = {
    "p", "div", "li", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "dt", "dd",
    "figcaption", "caption", "section", "article", "body", "span_block",
}  # fmt: skip


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def _collect(block, nodes: list[tuple[Any, str]]) -> None:
    """Text slots (element, 'text'|'tail') of `block` outside nested blocks / skipped tags."""
    if block.text:
        nodes.append((block, "text"))
    for child in block:
        name = _local(child.tag)
        if isinstance(child.tag, str) and name not in _SKIP and name not in _BLOCK:
            _collect(child, nodes)
        if child.tail:
            nodes.append((child, "tail"))


def _redistribute(slots: list[tuple[Any, str]], new_text: str) -> None:
    pairs = split_pairs(new_text, canon=False)
    k = 0
    for el, attr in slots:
        old = getattr(el, attr)
        n = sum(1 for c in old if c not in MARKS)
        setattr(el, attr, "".join(b + m for b, m in pairs[k : k + n]))
        k += n


def _check_epub(zin: zipfile.ZipFile, src: Path) -> None:
    security.check_zip(
        zin, max_members=20_000, max_total=1024**3, max_member=256 * 1024**2, max_ratio=500,
        error=lambda r: bad_input(f"EPUB rejected: {r}", src),
    )  # fmt: skip


def diacritize_xhtml(data: bytes, fn: Diacritize) -> tuple[bytes, int]:
    if security.has_xml_declaration(data, security.ENTITY_MARKERS):
        raise etree.XMLSyntaxError("entity declarations are not allowed", 0, 0, 0)
    tree = etree.fromstring(data, security.hardened_xml_parser()).getroottree()
    root = tree.getroot()
    changed = 0
    for el in root.iter():
        if not isinstance(el.tag, str) or _local(el.tag) not in _BLOCK:
            continue
        if any(_local(a.tag) in _SKIP for a in el.iterancestors() if isinstance(a.tag, str)):
            continue
        slots: list[tuple[Any, str]] = []
        _collect(el, slots)
        old = "".join(getattr(e, a) for e, a in slots)
        if not has_arabic_letters(old):
            continue
        new = fn(old)
        if new != old and strip_marks(new) == strip_marks(old):
            _redistribute(slots, new)
            changed += 1
    doctype = tree.docinfo.doctype or None
    out = etree.tostring(tree, xml_declaration=True, encoding="UTF-8", doctype=doctype)
    return out, changed


def diacritize_epub(src: Path, dst: Path, fn: Diacritize) -> dict[str, Any]:
    stats = {"documents": 0, "blocks_changed": 0, "skipped": []}
    try:
        zin = zipfile.ZipFile(src)
    except (zipfile.BadZipFile, OSError) as exc:
        raise bad_input("not a valid EPUB (zip)", src) from exc
    try:
        _check_epub(zin, src)
    except BaseException:
        zin.close()
        raise
    tmp = Path(dst).with_name(f".~mizaj_tmp.{Path(dst).name}")
    with zin, zipfile.ZipFile(tmp, "w") as zout:
        names = [i.filename for i in zin.infolist()]
        if "mimetype" in names:  # must be first and stored
            zout.writestr("mimetype", zin.read("mimetype"), compress_type=zipfile.ZIP_STORED)
        for info in zin.infolist():
            if info.filename == "mimetype":
                continue
            data = zin.read(info)
            if info.filename.lower().endswith(XHTML_EXT):
                try:
                    data, n = diacritize_xhtml(data, fn)
                    stats["documents"] += 1
                    stats["blocks_changed"] += n
                except etree.XMLSyntaxError:
                    stats["skipped"].append(info.filename)
            zout.writestr(info.filename, data, compress_type=zipfile.ZIP_DEFLATED)
    tmp.replace(dst)
    return stats


def epub_text(src: Path) -> str:
    try:
        zin = zipfile.ZipFile(src)
    except (zipfile.BadZipFile, OSError) as exc:
        raise bad_input("not a valid EPUB (zip)", src) from exc
    parts: list[str] = []
    parser = security.hardened_xml_parser()
    with zin:
        _check_epub(zin, src)
        for info in zin.infolist():
            if not info.filename.lower().endswith(XHTML_EXT) or info.file_size > 50 * 1024**2:
                continue
            data = zin.read(info)
            if security.has_xml_declaration(data, security.ENTITY_MARKERS):
                continue
            try:
                root = etree.fromstring(data, parser)
            except etree.XMLSyntaxError:
                continue
            for el in root.iter():
                if isinstance(el.tag, str) and _local(el.tag) in _BLOCK - {
                    "body",
                    "section",
                    "div",
                    "article",
                }:
                    slots: list[tuple[Any, str]] = []
                    _collect(el, slots)
                    t = "".join(getattr(e, a) for e, a in slots).strip()
                    if t:
                        parts.append(t)
    return "\n".join(parts)


# ---------------------------------------------------------------- PDF
def pdf_import_text(path: Path) -> tuple[str, dict[str, Any]]:
    try:
        from pdfminer.high_level import extract_text
    except ImportError as exc:
        raise _dep("pdfminer.six (MIT)") from exc
    try:
        raw = extract_text(str(path))
    except Exception as exc:  # noqa: BLE001
        raise bad_input(f"cannot read PDF: {type(exc).__name__}", path) from exc
    # PDFs often hold Arabic presentation forms (U+FB50..U+FEFF): NFKC maps them to base letters
    text = unicodedata.normalize("NFKC", raw).replace("\x0c", "\n\n")
    return text, {
        "presentation_forms_normalized": raw != text,
        "empty": not text.strip(),
        "hint": "No text layer: use POST /api/ocr for scanned PDFs." if not text.strip() else None,
    }


def _dep(name: str) -> MizajError:
    return MizajError(
        "ERR_DEPENDENCY_MISSING", 501, "مكتبة مطلوبة غير مثبتة.", f"Optional dependency missing: {name}",
        {"dependency": name},
    )  # fmt: skip


_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/amiri/Amiri-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/tahoma.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
]


def pdf_export(
    path: Path, text: str, title: str = "", font_path: str | None = None
) -> dict[str, Any]:
    """Pure-Python PDF (reportlab BSD + arabic-reshaper MIT + python-bidi LGPL). Needs a TTF
    with Arabic glyphs; marks are shaped by the font (DejaVu/Amiri/Arial all carry them)."""
    try:
        import arabic_reshaper
        from bidi.algorithm import get_display
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.pdfgen import canvas
    except ImportError as exc:
        raise _dep("reportlab, arabic-reshaper, python-bidi") from exc
    font = next(
        (f for f in ([font_path] if font_path else []) + _FONT_CANDIDATES if Path(f).is_file()),
        None,
    )
    if font is None:
        raise MizajError(
            "ERR_FONT_MISSING", 501, "لا يوجد خط عربي لإنشاء ملف PDF.",
            "No Arabic-capable TTF found; pass font_path.", {},
        )  # fmt: skip
    pdfmetrics.registerFont(TTFont("MizajArabic", font))
    reshaper = arabic_reshaper.ArabicReshaper({"delete_harakat": False, "support_ligatures": False})
    width, height = A4
    margin, size = 56, 16
    leading = size * 1.9
    tmp_pdf = Path(path).with_name(f".~mizaj_tmp.{Path(path).name}")
    c = canvas.Canvas(str(tmp_pdf), pagesize=A4)
    c.setTitle(title or "Mizaj")
    c.setFont("MizajArabic", size)
    y = height - margin
    pages = 1
    max_w = width - 2 * margin
    for para in text.replace("\r\n", "\n").split("\n"):
        words = para.split(" ")
        lines, cur = [], ""
        for w in words:
            trial = (cur + " " + w).strip()
            vis = get_display(reshaper.reshape(trial))
            if pdfmetrics.stringWidth(vis, "MizajArabic", size) > max_w and cur:
                lines.append(cur)
                cur = w
            else:
                cur = trial
        lines.append(cur)
        for ln in lines:
            if y < margin:
                c.showPage()
                c.setFont("MizajArabic", size)
                y = height - margin
                pages += 1
            c.drawRightString(width - margin, y, get_display(reshaper.reshape(ln)))
            y -= leading
    c.save()
    tmp_pdf.replace(path)
    return {"pages": pages, "font": Path(font).name}


# ---------------------------------------------------------------- dispatch
TEXT_FORMATS = {".txt": "txt", ".md": "md", ".markdown": "md", ".srt": "srt"}


def diacritize_text_format(fmt: str, text: str, fn: Diacritize) -> str:
    if fmt == "md":
        return diacritize_markdown(text, fn)
    if fmt == "srt":
        return diacritize_srt(text, fn)
    return fn(text)


def format_of(path: Path) -> str:
    ext = Path(path).suffix.lower()
    if ext in TEXT_FORMATS:
        return TEXT_FORMATS[ext]
    if ext == ".epub":
        return "epub"
    if ext == ".docx":
        return "docx"
    if ext == ".pdf":
        return "pdf"
    raise validation_error(f"unsupported format '{ext}'", {"ext": ext})
