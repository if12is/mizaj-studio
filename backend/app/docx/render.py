"""DOCX -> sanitized HTML for the in-app "page view" (عرض الصفحة).

Security model: this module NEVER copies markup or style text from the document. Every tag is
emitted by code, every text node goes through `html.escape`, and every CSS value is rebuilt
from parsed numbers / validated tokens (hex colors, whitelisted keywords, sanitized font
names). Images are embedded as `data:` URIs after a magic-byte check and size limits. No
`<script>`, `<style>`, `<a>`, event handlers or external URLs are ever produced.

Diacritized text is applied with the SAME paragraph model as the export pipeline
(`app.docx.extractor.iter_units` / `apply_unit`), so marks land in the same runs.
"""

from __future__ import annotations

import base64
import html
import re
import zipfile
from typing import Any

from docx.oxml import parse_xml
from lxml import etree

from app.core.errors import docx_corrupt
from app.docx.extractor import PLACEHOLDER
from app.engine.normalize import MARKS, has_arabic_letters, split_pairs

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"


def _w(name: str) -> str:
    return f"{{{W}}}{name}"


MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024
MAX_PARAGRAPHS = 60_000
MAX_TABLE_DEPTH = 6

HEX_RE = re.compile(r"^[0-9A-Fa-f]{6}$")
FONT_OK = re.compile(r"[^\w .\-]", re.UNICODE)

HIGHLIGHT = {
    "yellow": "#ffff00", "green": "#00ff00", "cyan": "#00ffff", "magenta": "#ff00ff",
    "blue": "#0000ff", "red": "#ff0000", "darkBlue": "#000080", "darkCyan": "#008080",
    "darkGreen": "#008000", "darkMagenta": "#800080", "darkRed": "#800000",
    "darkYellow": "#808000", "darkGray": "#808080", "lightGray": "#c0c0c0",
    "black": "#000000", "white": "#ffffff",
}  # fmt: skip
BORDER_STYLE = {
    "single": "solid", "thick": "solid", "double": "double", "dotted": "dotted",
    "dashed": "dashed", "dotDash": "dashed", "dotDotDash": "dashed", "dashSmallGap": "dashed",
    "triple": "double", "thinThickSmallGap": "double", "thickThinSmallGap": "double",
    "wave": "solid", "outset": "solid", "inset": "solid",
}  # fmt: skip
IMG_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
)

# Arabic-aware fallbacks: the document's own font name first (used when installed, e.g. on
# Windows), then bundled/installed Arabic faces so a missing Word font never falls to tofu.
SERIF_AR = "'Amiri','Noto Naskh Arabic','Times New Roman',serif"
SANS_AR = "'Cairo','Noto Sans Arabic','Segoe UI',Tahoma,Arial,sans-serif"
HEADING_FONTS = ("bold heading", "bold", "titr", "jeddah", "kufi", "cairo", "hacen", "sakkal")
SANS_FONTS = ("arial", "tahoma", "segoe", "calibri", "verdana", "cairo", "dubai", "helvetica")


def _font_css(name: str | None, cs: bool) -> str:
    if not name:
        return SERIF_AR if cs else "'Times New Roman',serif"
    clean = FONT_OK.sub("", name).strip()[:60]
    low = clean.lower()
    if any(k in low for k in HEADING_FONTS):
        tail = SANS_AR
    elif any(k in low for k in SANS_FONTS):
        tail = SANS_AR if cs else "Arial,Helvetica,sans-serif"
    else:
        tail = SERIF_AR if cs else "'Times New Roman',serif"
    return f"'{clean}',{tail}" if clean else tail


# ------------------------------------------------------------------ property parsing
def _local(el) -> str:
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def _on(el) -> bool:
    return el.get(_w("val"), "true").lower() not in ("0", "false", "off", "none")


def _int(v, default=None):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


_RPR_BOOL = {"b", "bCs", "i", "iCs", "strike", "dstrike", "caps", "smallCaps", "vanish", "rtl"}


def parse_rpr(rpr) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if rpr is None:
        return out
    for c in rpr:
        n = _local(c)
        if n in _RPR_BOOL:
            out[n] = _on(c)
        elif n == "u":
            out["u"] = c.get(_w("val"), "single")
        elif n == "color":
            out["color"] = c.get(_w("val"), "auto")
        elif n in ("sz", "szCs"):
            v = _int(c.get(_w("val")))
            if v:
                out[n] = v
        elif n == "rFonts":
            out["rFonts"] = {
                k: c.get(_w(k))
                for k in ("ascii", "hAnsi", "cs", "asciiTheme", "hAnsiTheme", "cstheme")
                if c.get(_w(k))
            }
        elif n == "highlight":
            out["highlight"] = c.get(_w("val"))
        elif n == "shd":
            out["shd"] = c.get(_w("fill"))
        elif n == "vertAlign":
            out["vertAlign"] = c.get(_w("val"))
        elif n == "rStyle":
            out["rStyle"] = c.get(_w("val"))
    # python-docx (and many generators) set only the Latin variants: let them cover Arabic too
    for lat, cs in (("sz", "szCs"), ("b", "bCs"), ("i", "iCs")):
        if lat in out and cs not in out:
            out[cs] = out[lat]
    rf = out.get("rFonts")
    if rf and "cs" not in rf and "cstheme" not in rf and (rf.get("ascii") or rf.get("hAnsi")):
        rf["cs"] = rf.get("ascii") or rf["hAnsi"]
    return out


def parse_borders(el) -> dict[str, dict[str, str | None]]:
    out: dict[str, dict[str, str | None]] = {}
    if el is None:
        return out
    for c in el:
        n = _local(c)
        if n in ("top", "bottom", "left", "right", "start", "end", "between", "insideH", "insideV"):
            out[n] = {
                "val": c.get(_w("val")),
                "sz": c.get(_w("sz")),
                "color": c.get(_w("color")),
                "space": c.get(_w("space")),
            }
    return out


def parse_ppr(ppr) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if ppr is None:
        return out
    for c in ppr:
        n = _local(c)
        if n == "jc":
            out["jc"] = c.get(_w("val"))
        elif n == "bidi":
            out["bidi"] = _on(c)
        elif n == "ind":
            out["ind"] = {
                k: _int(c.get(_w(k)))
                for k in ("left", "right", "start", "end", "firstLine", "hanging")
                if c.get(_w(k)) is not None
            }
        elif n == "spacing":
            out["spacing"] = {
                k: c.get(_w(k))
                for k in ("before", "after", "line", "lineRule")
                if c.get(_w(k)) is not None
            }
        elif n == "pBdr":
            out["pBdr"] = parse_borders(c)
        elif n == "shd":
            out["shd"] = c.get(_w("fill"))
        elif n == "pStyle":
            out["pStyle"] = c.get(_w("val"))
        elif n == "numPr":
            nid = c.find(_w("numId"))
            lvl = c.find(_w("ilvl"))
            out["numPr"] = {
                "numId": _int(nid.get(_w("val"))) if nid is not None else None,
                "ilvl": (_int(lvl.get(_w("val")), 0) if lvl is not None else None),
            }
    return out


def _merge(base: dict, over: dict) -> dict:
    out = dict(base)
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


class Styles:
    """Resolved styles.xml: docDefaults + basedOn chains, plus theme fonts and numbering."""

    def __init__(self, doc) -> None:
        self.p: dict[str, dict] = {}
        self.r: dict[str, dict] = {}
        self.tbl: dict[str, dict] = {}
        self.default_p = self.default_t = None
        self.doc_r: dict[str, Any] = {}
        self.doc_p: dict[str, Any] = {}
        self._raw: dict[str, tuple[str, str | None, dict, dict, dict]] = {}
        self.theme: dict[str, str] = {}
        self.numbering: dict[int, dict[int, dict]] = {}
        try:
            self._load_styles(doc.styles.element)
        except Exception:  # missing/odd styles part: render with defaults
            pass
        try:
            self._load_theme(doc)
        except Exception:
            pass
        try:
            self._load_numbering(doc.part.numbering_part.element)
        except Exception:
            pass

    def _load_styles(self, root) -> None:
        dd = root.find(_w("docDefaults"))
        if dd is not None:
            rp = dd.find(f"{_w('rPrDefault')}/{_w('rPr')}")
            pp = dd.find(f"{_w('pPrDefault')}/{_w('pPr')}")
            self.doc_r = parse_rpr(rp)
            self.doc_p = parse_ppr(pp)
        for st in root.findall(_w("style")):
            sid = st.get(_w("styleId"))
            if not sid:
                continue
            kind = st.get(_w("type"))
            based = st.find(_w("basedOn"))
            self._raw[sid] = (
                kind or "",
                based.get(_w("val")) if based is not None else None,
                parse_ppr(st.find(_w("pPr"))),
                parse_rpr(st.find(_w("rPr"))),
                self._tbl_props(st.find(_w("tblPr"))),
            )
            if st.get(_w("default")) in ("1", "true"):
                if kind == "paragraph":
                    self.default_p = sid
                elif kind == "table":
                    self.default_t = sid

    @staticmethod
    def _tbl_props(tp) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if tp is None:
            return out
        b = tp.find(_w("tblBorders"))
        if b is not None:
            out["borders"] = parse_borders(b)
        m = tp.find(_w("tblCellMar"))
        if m is not None:
            out["mar"] = {
                _local(c): _int(c.get(_w("w")))
                for c in m
                if _local(c) in ("top", "bottom", "left", "right", "start", "end")
            }
        return out

    def chain(self, sid: str | None, kind: str) -> tuple[dict, dict, dict]:
        """(pPr, rPr, tblPr) merged along the basedOn chain (base first)."""
        order: list[str] = []
        seen: set[str] = set()
        cur = sid
        while cur and cur in self._raw and cur not in seen and len(order) < 12:
            seen.add(cur)
            order.append(cur)
            cur = self._raw[cur][1]
        p: dict = {}
        r: dict = {}
        t: dict = {}
        for s in reversed(order):
            _, _, sp, sr, st = self._raw[s]
            p, r, t = _merge(p, sp), _merge(r, sr), _merge(t, st)
        return p, r, t

    def _load_theme(self, doc) -> None:
        for rel in doc.part.rels.values():
            if rel.is_external or not rel.reltype.endswith("/theme"):
                continue
            root = parse_xml(rel.target_part.blob)
            for key, tag in (("minor", "minorFont"), ("major", "majorFont")):
                f = root.find(f".//{{{A}}}{tag}")
                if f is None:
                    continue
                lat = f.find(f"{{{A}}}latin")
                cs = f.find(f"{{{A}}}cs")
                if lat is not None and lat.get("typeface"):
                    self.theme[f"{key}Latin"] = lat.get("typeface")
                if cs is not None and cs.get("typeface"):
                    self.theme[f"{key}Bidi"] = cs.get("typeface")
                else:
                    for sf in f.findall(f"{{{A}}}font"):
                        if sf.get("script") == "Arab":
                            self.theme[f"{key}Bidi"] = sf.get("typeface", "")

    def _load_numbering(self, root) -> None:
        abstract: dict[int, dict[int, dict]] = {}
        for an in root.findall(_w("abstractNum")):
            aid = _int(an.get(_w("abstractNumId")))
            lv: dict[int, dict] = {}
            for lvl in an.findall(_w("lvl")):
                i = _int(lvl.get(_w("ilvl")), 0)
                fmt = lvl.find(_w("numFmt"))
                txt = lvl.find(_w("lvlText"))
                start = lvl.find(_w("start"))
                lv[i] = {
                    "fmt": fmt.get(_w("val")) if fmt is not None else "decimal",
                    "text": txt.get(_w("val")) if txt is not None else "%1.",
                    "start": _int(start.get(_w("val")), 1) if start is not None else 1,
                    "pPr": parse_ppr(lvl.find(_w("pPr"))),
                    "rPr": parse_rpr(lvl.find(_w("rPr"))),
                }
            if aid is not None:
                abstract[aid] = lv
        for num in root.findall(_w("num")):
            nid = _int(num.get(_w("numId")))
            ref = num.find(_w("abstractNumId"))
            if nid is None or ref is None:
                continue
            self.numbering[nid] = dict(abstract.get(_int(ref.get(_w("val"))), {}))

    def theme_font(self, theme_name: str) -> str | None:
        t = theme_name.lower()
        key = "minor" if "minor" in t else "major"
        return self.theme.get(f"{key}Bidi" if "bidi" in t else f"{key}Latin")


# ------------------------------------------------------------------ number formatting
def _roman(n: int) -> str:
    out = ""
    for v, s in ((1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"),
                 (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")):  # noqa: E501
        while n >= v:
            out += s
            n -= v
    return out


def _letters(n: int) -> str:
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(97 + r) + s
    return s


AR_ABJAD = "أبجدهوزحطيكلمنسعفصقرشتثخذضظغ"


def _format_num(fmt: str, n: int) -> str:
    if fmt == "upperRoman":
        return _roman(n).upper()
    if fmt == "lowerRoman":
        return _roman(n)
    if fmt == "upperLetter":
        return _letters(n).upper()
    if fmt == "lowerLetter":
        return _letters(n)
    if fmt in ("arabicAbjad", "arabicAlpha"):
        return AR_ABJAD[(n - 1) % len(AR_ABJAD)]
    if fmt == "hindi1" or fmt == "hindiNumbers":
        return str(n).translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩"))
    if fmt == "decimalZero":
        return f"{n:02d}"
    return str(n)


# ------------------------------------------------------------------ renderer
def _css(props: list[tuple[str, str]]) -> str:
    return ";".join(f"{k}:{v}" for k, v in props if v)


def _pt(twips: float) -> str:
    return f"{round(twips / 20, 2):g}pt"


def _color(val: str | None) -> str | None:
    if val and HEX_RE.match(val):
        return "#" + val.lower()
    return None


def _border(b: dict[str, str | None] | None) -> str | None:
    if not b or b.get("val") in (None, "nil", "none"):
        return "none" if b else None
    style = BORDER_STYLE.get(b["val"] or "", "solid")
    sz = _int(b.get("sz"), 4) or 4
    width = max(0.5, sz / 8)
    if style == "double":
        width = max(width, 2.25)
    if b["val"] == "thick":
        width = max(width, 1.5)
    col = _color(b.get("color")) or "#000000"
    return f"{width:g}pt {style} {col}"


class Renderer:
    def __init__(self, doc, styles: Styles) -> None:
        self.doc = doc
        self.st = styles
        self.img_total = 0
        self.paragraphs = 0
        self.images = 0
        self.skipped_images = 0
        self.counters: dict[tuple[int, int], int] = {}
        self.truncated = False
        self.diacritized = False
        self.rels = doc.part.related_parts

    # ---- runs
    def _fonts(self, rpr: dict, cs: bool) -> str:
        f = rpr.get("rFonts", {})
        name = f.get("cs") if cs else (f.get("ascii") or f.get("hAnsi"))
        if not name:
            theme = f.get("cstheme") if cs else (f.get("asciiTheme") or f.get("hAnsiTheme"))
            if theme:
                name = self.st.theme_font(theme)
        return _font_css(name, cs)

    def _run_css(self, rpr: dict, cs: bool, inherit: dict) -> str:
        b = rpr.get("bCs" if cs else "b", False)
        i = rpr.get("iCs" if cs else "i", False)
        sz = rpr.get("szCs" if cs else "sz") or 22
        props = [
            ("font-family", self._fonts(rpr, cs)),
            ("font-size", f"{sz / 2:g}pt"),
        ]
        if b:
            props.append(("font-weight", "700"))
        else:
            props.append(("font-weight", "400"))
        if i:
            props.append(("font-style", "italic"))
        deco = []
        u = rpr.get("u")
        if u and u != "none":
            deco.append("underline")
        if rpr.get("strike") or rpr.get("dstrike"):
            deco.append("line-through")
        if deco:
            props.append(("text-decoration-line", " ".join(deco)))
            if u == "double":
                props.append(("text-decoration-style", "double"))
            elif u in ("dotted", "dottedHeavy"):
                props.append(("text-decoration-style", "dotted"))
            elif u in ("dash", "dashedHeavy", "dashLong"):
                props.append(("text-decoration-style", "dashed"))
            elif u in ("wave", "wavyHeavy", "wavyDouble"):
                props.append(("text-decoration-style", "wavy"))
        col = _color(rpr.get("color"))
        if col:
            props.append(("color", col))
        hl = HIGHLIGHT.get(rpr.get("highlight") or "")
        shd = _color(rpr.get("shd"))
        if hl or shd:
            props.append(("background-color", hl or shd or ""))
        if rpr.get("caps"):
            props.append(("text-transform", "uppercase"))
        if rpr.get("smallCaps"):
            props.append(("font-variant", "small-caps"))
        va = rpr.get("vertAlign")
        if va == "superscript":
            props.append(("vertical-align", "super"))
            props.append(("font-size", f"{sz / 2 * 0.65:g}pt"))
        elif va == "subscript":
            props.append(("vertical-align", "sub"))
            props.append(("font-size", f"{sz / 2 * 0.65:g}pt"))
        return _css(props)

    def _run_props(self, r, base: dict) -> dict:
        direct = parse_rpr(r.find(_w("rPr")))
        rs = direct.get("rStyle")
        merged = base
        if rs:
            _, rp, _ = self.st.chain(rs, "character")
            merged = _merge(merged, rp)
        return _merge(merged, direct)

    def run_html(self, r, base: dict, p_el, anchor_state: dict) -> str:
        rpr = self._run_props(r, base)
        if rpr.get("vanish"):
            return ""
        chunks: list[str] = []  # ("t", text) | ("html", str)
        parts: list[tuple[str, str]] = []
        for c in r:
            n = _local(c)
            if n == "t":
                parts.append(("t", c.text or ""))
            elif n == "tab":
                parts.append(("t", "\t"))
            elif n in ("br", "cr"):
                if c.get(_w("type")) == "page":
                    parts.append(("h", '<span class="dp-pagebreak"></span>'))
                else:
                    parts.append(("h", "<br>"))
            elif n == "noBreakHyphen":
                parts.append(("t", "‑"))
            elif n == "drawing":
                img = self._drawing(c, anchor_state)
                if img:
                    parts.append(("h", img))
            elif n == "AlternateContent":
                choice = c.find(f"{{{MC}}}Choice")
                if choice is not None:
                    for d in choice.iter(_w("drawing")):
                        img = self._drawing(d, anchor_state)
                        if img:
                            parts.append(("h", img))
        text_all = "".join(v for k, v in parts if k == "t")
        cs = bool(rpr.get("rtl")) or has_arabic_letters(text_all)
        style = self._run_css(rpr, cs, base)
        out: list[str] = []
        buf: list[str] = []

        def flush() -> None:
            if buf:
                out.append(
                    f'<span style="{style}"'
                    f'{" lang=ar" if cs else ""}>{html.escape("".join(buf), quote=True)}</span>'
                )
                buf.clear()

        for kind, val in parts:
            if kind == "t":
                buf.append(val)
            else:
                flush()
                out.append(val)
        flush()
        del chunks
        return "".join(out)

    # ---- images
    def _drawing(self, d, state: dict) -> str:
        node = next((c for c in d if _local(c) in ("inline", "anchor")), None)
        if node is None:
            return ""
        blip = node.find(f".//{{{A}}}blip")
        ext = node.find(f"{{{WP}}}extent")
        if blip is None or ext is None:
            return ""
        rid = blip.get(f"{{{R}}}embed")
        cx = _int(ext.get("cx"), 0) or 0
        cy = _int(ext.get("cy"), 0) or 0
        if not rid or cx <= 0 or cy <= 0 or cx > 200_000_000 or cy > 200_000_000:
            return ""
        try:
            part = self.rels[rid]
            blob = part.blob
        except Exception:
            self.skipped_images += 1
            return ""
        mime = next((m for sig, m in IMG_MAGIC if blob.startswith(sig)), None)
        if mime is None and blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
            mime = "image/webp"
        if (
            mime is None
            or len(blob) > MAX_IMAGE_BYTES
            or self.img_total + len(blob) > MAX_TOTAL_IMAGE_BYTES
        ):
            self.skipped_images += 1
            return ""
        self.img_total += len(blob)
        self.images += 1
        descr = (node.find(f"{{{WP}}}docPr").get("descr") or "") if node.find(f"{{{WP}}}docPr") is not None else ""  # noqa: E501
        w_pt, h_pt = cx / 12700, cy / 12700
        props = [("width", f"{w_pt:.2f}pt"), ("height", f"{h_pt:.2f}pt"), ("max-width", "none")]
        if _local(node) == "anchor":
            wrap = next(
                (_local(c) for c in node if _local(c).startswith("wrap")), "wrapNone"
            )
            ph = node.find(f"{{{WP}}}positionH")
            pv = node.find(f"{{{WP}}}positionV")
            off_h = ph.find(f"{{{WP}}}posOffset") if ph is not None else None
            off_v = pv.find(f"{{{WP}}}posOffset") if pv is not None else None
            if wrap in ("wrapNone", "wrapTopAndBottom") or node.get("behindDoc") == "1":
                state["abs"] = True
                props.append(("position", "absolute"))
                hx = (_int(off_h.text, 0) if off_h is not None else 0) / 12700
                vy = (_int(off_v.text, 0) if off_v is not None else 0) / 12700
                props.append(("left", f"{hx:.2f}pt"))
                props.append(("top", f"{vy:.2f}pt"))
                if node.get("behindDoc") == "1":
                    props.append(("z-index", "0"))
                else:
                    props.append(("z-index", "2"))
                props.append(("pointer-events", "none"))
            else:
                side = "right" if (off_h is not None and (_int(off_h.text, 0) or 0) > 2_000_000) else "left"  # noqa: E501
                props.append(("float", side))
                props.append(("margin", "0 6pt 3pt 6pt"))
        else:
            props.append(("vertical-align", "bottom"))
        data = base64.b64encode(blob).decode("ascii")
        return (
            f'<img src="data:{mime};base64,{data}" alt="{html.escape(descr[:200], quote=True)}"'
            f' style="{_css(props)}">'
        )

    # ---- paragraphs
    def _ppr_effective(self, p) -> tuple[dict, dict]:
        direct = parse_ppr(p.find(_w("pPr")))
        sid = direct.get("pStyle") or self.st.default_p
        sp, sr, _ = self.st.chain(sid, "paragraph")
        eff = _merge(_merge(self.st.doc_p, sp), direct)
        base_r = _merge(self.st.doc_r, sr)
        return eff, base_r

    def _numbering(self, eff: dict) -> tuple[str, dict, dict] | None:
        np = eff.get("numPr")
        if not np or not np.get("numId"):
            return None
        lv = self.st.numbering.get(np["numId"], {})
        i = np.get("ilvl") or 0
        lvl = lv.get(i)
        if not lvl:
            return None
        key = (np["numId"], i)
        self.counters[key] = self.counters.get(key, lvl["start"] - 1) + 1
        for deeper in [k for k in self.counters if k[0] == np["numId"] and k[1] > i]:
            del self.counters[deeper]
        if lvl["fmt"] == "bullet":
            label = "•"
        elif lvl["fmt"] == "none":
            label = ""
        else:
            label = lvl["text"] or "%1."
            for j in range(9):
                cnt = self.counters.get((np["numId"], j))
                fmt = lv.get(j, {}).get("fmt", "decimal")
                label = label.replace(f"%{j + 1}", _format_num(fmt, cnt) if cnt else "")
        return label, lvl["pPr"], lvl["rPr"]

    def paragraph(self, p, depth: int = 0) -> str:
        self.paragraphs += 1
        if self.paragraphs > MAX_PARAGRAPHS:
            self.truncated = True
            return ""
        eff, base_r = self._ppr_effective(p)
        num = self._numbering(eff)
        if num:
            eff = _merge(eff, {"ind": num[1].get("ind", {})})
        bidi = bool(eff.get("bidi"))
        props: list[tuple[str, str]] = []
        jc = eff.get("jc") or "left"
        align = {
            "left": "start", "start": "start", "right": "end", "end": "end",
            "center": "center", "both": "justify", "distribute": "justify",
        }.get(jc, "start")  # fmt: skip
        props.append(("text-align", align))
        if jc in ("both", "distribute"):
            props.append(("text-align-last", "start"))
        ind = eff.get("ind", {})
        start = ind.get("start", ind.get("left"))
        end = ind.get("end", ind.get("right"))
        if start:
            props.append(("margin-inline-start", _pt(start)))
        if end:
            props.append(("margin-inline-end", _pt(end)))
        if ind.get("hanging"):
            props.append(("text-indent", "-" + _pt(ind["hanging"])))
        elif ind.get("firstLine"):
            props.append(("text-indent", _pt(ind["firstLine"])))
        sp = eff.get("spacing", {})
        props.append(("margin-top", _pt(_int(sp.get("before"), 0) or 0)))
        props.append(("margin-bottom", _pt(_int(sp.get("after"), 0) or 0)))
        line = _int(sp.get("line"))
        rule = sp.get("lineRule") or "auto"
        # Word "single" ~ the font's natural height (~1.2-1.35 for Arabic faces); marks need more
        floor = 1.6 if self.diacritized else 1.3
        size_pt = ((base_r.get("szCs") if bidi else base_r.get("sz")) or 22) / 2
        if line and rule == "auto":
            props.append(("line-height", f"{max(floor, line / 240 * 1.25):.3f}"))
        elif line and rule == "exact":
            props.append(("line-height", _pt(line)))
        elif line:  # atLeast
            props.append(("line-height", f"max({_pt(line)},{floor * size_pt:.2f}pt)"))
        else:
            props.append(("line-height", f"{floor:.2f}"))
        bd = eff.get("pBdr", {})
        phys = {"top": "top", "bottom": "bottom", "left": "inline-start", "right": "inline-end",
                "start": "inline-start", "end": "inline-end"}  # fmt: skip
        for side, css_side in phys.items():
            if side in bd:
                v = _border(bd[side])
                if v:
                    props.append((f"border-{css_side}", v))
                sp_pt = _int(bd[side].get("space"), 0) or 0
                if sp_pt and v != "none":
                    props.append((f"padding-{css_side}", f"{min(sp_pt, 31)}pt"))
        shd = _color(eff.get("shd"))
        if shd:
            props.append(("background-color", shd))
        state: dict[str, Any] = {}
        inner = self._paragraph_runs(p, base_r, state)
        if state.get("abs"):
            props.append(("position", "relative"))
        if num and num[0]:
            nrpr = _merge(base_r, num[2])
            lbl = html.escape(num[0])
            inner = (
                f'<span class="dp-num" style="{self._run_css(nrpr, has_arabic_letters(num[0]) or bidi, base_r)}">'  # noqa: E501
                f"{lbl}</span>" + inner
            )
        if not inner:
            inner = "&#8203;"  # keep empty paragraphs at their line height
            sz = (base_r.get("szCs") if bidi else base_r.get("sz")) or 22
            props.append(("min-height", f"{sz / 2 * 1.3:.2f}pt"))
        return f'<p dir="{"rtl" if bidi else "ltr"}" style="{_css(props)}">{inner}</p>'

    def _paragraph_runs(self, node, base_r: dict, state: dict) -> str:
        out: list[str] = []
        for c in node:
            n = _local(c)
            if n == "r":
                out.append(self.run_html(c, base_r, node, state))
            elif n in ("hyperlink", "ins", "smartTag", "fldSimple", "sdtContent", "customXml"):
                out.append(self._paragraph_runs(c, base_r, state))
            elif n == "sdt":
                cont = c.find(_w("sdtContent"))
                if cont is not None:
                    out.append(self._paragraph_runs(cont, base_r, state))
        return "".join(out)

    # ---- tables
    def table(self, tbl, depth: int) -> str:
        if depth > MAX_TABLE_DEPTH:
            return ""
        tp = tbl.find(_w("tblPr"))
        sid = None
        if tp is not None:
            ts = tp.find(_w("tblStyle"))
            sid = ts.get(_w("val")) if ts is not None else None
        sid = sid or self.st.default_t
        _, _, style_t = self.st.chain(sid, "table")
        direct = self.st._tbl_props(tp)
        merged = _merge(style_t, direct)
        borders = merged.get("borders", {})
        mar = merged.get("mar", {})
        rtl = tp is not None and tp.find(_w("bidiVisual")) is not None
        props = [("border-collapse", "collapse"), ("table-layout", "fixed")]
        grid = [
            _int(g.get(_w("w")), 0) or 0
            for g in (tbl.find(_w("tblGrid")) if tbl.find(_w("tblGrid")) is not None else [])
        ]
        width_pt = None
        if tp is not None:
            tw = tp.find(_w("tblW"))
            if tw is not None:
                t, v = tw.get(_w("type")), _int(tw.get(_w("w")), 0) or 0
                if t == "dxa" and v:
                    width_pt = v / 20
                elif t == "pct" and v:
                    props.append(("width", f"{v / 50:g}%"))
            ind = tp.find(f"{_w('tblInd')}")
            if ind is not None and (_int(ind.get(_w("w")), 0) or 0):
                props.append(("margin-inline-start", _pt(_int(ind.get(_w("w")), 0) or 0)))
            jc = tp.find(_w("jc"))
            if jc is not None and jc.get(_w("val")) == "center":
                props.append(("margin-inline", "auto"))
            elif jc is not None and jc.get(_w("val")) in ("right", "end"):
                props.append(("margin-inline-start", "auto"))
        if width_pt is None and grid and not any(k == "width" for k, _ in props):
            width_pt = sum(grid) / 20
        if width_pt:
            props.append(("width", f"{width_pt:.2f}pt"))
        cols = "".join(f'<col style="width:{g / 20:.2f}pt">' for g in grid if g)
        rows = tbl.findall(_w("tr"))
        # row model for vertical merges
        model: list[list[dict]] = []
        for tr in rows:
            cells = []
            gi = 0
            gb = tr.find(f"{_w('trPr')}/{_w('gridBefore')}")
            if gb is not None:
                gi += _int(gb.get(_w("val")), 0) or 0
            for tc in tr.findall(_w("tc")):
                tcp = tc.find(_w("tcPr"))
                span = 1
                vm = None
                if tcp is not None:
                    gs = tcp.find(_w("gridSpan"))
                    if gs is not None:
                        span = max(1, min(_int(gs.get(_w("val")), 1) or 1, 64))
                    v = tcp.find(_w("vMerge"))
                    if v is not None:
                        vm = v.get(_w("val")) or "continue"
                cells.append({"tc": tc, "tcp": tcp, "col": gi, "span": span, "vm": vm})
                gi += span
            model.append(cells)
        out = [f'<table dir="{"rtl" if rtl else "ltr"}" style="{_css(props)}">']
        if cols:
            out.append(f"<colgroup>{cols}</colgroup>")
        nrows = len(model)
        for ri, cells in enumerate(model):
            tr = rows[ri]
            h = tr.find(f"{_w('trPr')}/{_w('trHeight')}")
            hstyle = ""
            if h is not None and (_int(h.get(_w("val")), 0) or 0):
                hstyle = f' style="height:{_pt(_int(h.get(_w("val")), 0) or 0)}"'
            out.append(f"<tr{hstyle}>")
            ncols = max((c["col"] + c["span"] for c in cells), default=0)
            for ci, cell in enumerate(cells):
                if cell["vm"] == "continue":
                    continue
                rowspan = 1
                if cell["vm"] == "restart":
                    for nri in range(ri + 1, nrows):
                        nxt = next((c for c in model[nri] if c["col"] == cell["col"]), None)
                        if nxt is None or nxt["vm"] != "continue":
                            break
                        rowspan += 1
                out.append(
                    self._cell(cell, rowspan, ri, ci, nrows, len(cells), ncols, borders, mar,
                               depth, rtl)  # fmt: skip
                )
            out.append("</tr>")
        out.append("</table>")
        return "".join(out)

    def _cell(self, cell, rowspan, ri, ci, nrows, ncells, ncols, borders, mar, depth, rtl):
        tcp = cell["tcp"]
        props: list[tuple[str, str]] = [("vertical-align", "top"), ("overflow-wrap", "anywhere")]
        cb = parse_borders(tcp.find(_w("tcBorders"))) if tcp is not None else {}
        first_col, last_col = ci == 0, ci == ncells - 1
        # physical side of the first cell: right edge in a visually-RTL table
        left_edge = last_col if rtl else first_col
        right_edge = first_col if rtl else last_col
        sides = {
            "top": cb.get("top") or borders.get("top" if ri == 0 else "insideH"),
            "bottom": cb.get("bottom")
            or borders.get("bottom" if ri + rowspan >= nrows else "insideH"),
            "left": cb.get("left") or cb.get("start" if not rtl else "end")
            or borders.get("left" if left_edge else "insideV"),
            "right": cb.get("right") or cb.get("end" if not rtl else "start")
            or borders.get("right" if right_edge else "insideV"),
        }  # fmt: skip
        for side, b in sides.items():
            v = _border(b)
            if v:
                props.append((f"border-{side}", v))
        pads = {
            "top": mar.get("top", 0),
            "bottom": mar.get("bottom", 0),
            "left": mar.get("left", mar.get("start", 108)),
            "right": mar.get("right", mar.get("end", 108)),
        }
        for side, v in pads.items():
            props.append((f"padding-{side}", _pt(v or 0)))
        attrs = ""
        if cell["span"] > 1:
            attrs += f' colspan="{cell["span"]}"'
        if rowspan > 1:
            attrs += f' rowspan="{rowspan}"'
        if tcp is not None:
            shd = tcp.find(_w("shd"))
            if shd is not None:
                fill = _color(shd.get(_w("fill")))
                if fill:
                    props.append(("background-color", fill))
            va = tcp.find(_w("vAlign"))
            if va is not None:
                props[0] = (
                    "vertical-align",
                    {"center": "middle", "bottom": "bottom"}.get(va.get(_w("val")), "top"),
                )
        body = self.block_children(cell["tc"], depth + 1)
        return f'<td{attrs} style="{_css(props)}">{body or "<p>&#8203;</p>"}</td>'

    # ---- block level
    def block_children(self, node, depth: int = 0) -> str:
        out: list[str] = []
        for c in node:
            n = _local(c)
            if n == "p":
                out.append(self.paragraph(c, depth))
            elif n == "tbl":
                out.append(self.table(c, depth))
            elif n in ("sdt",):
                cont = c.find(_w("sdtContent"))
                if cont is not None:
                    out.append(self.block_children(cont, depth))
            elif n in ("ins", "customXml"):
                out.append(self.block_children(c, depth))
            if self.truncated:
                break
        return "".join(out)


# ------------------------------------------------------------------ diacritized text
def _lift(unit_text: str, line: str) -> str | None:
    """`line` (diacritized, no placeholders) -> text aligned with unit.text (placeholders for
    drawings etc. re-inserted), or None if the base letters differ."""
    pairs = split_pairs(line, canon=False)
    out: list[str] = []
    k = 0
    for ch in unit_text:
        if ch in MARKS:
            continue
        if ch == PLACEHOLDER:
            out.append(ch)
            continue
        if k >= len(pairs) or pairs[k][0] != ch:
            return None
        out.append(pairs[k][0] + pairs[k][1])
        k += 1
    return "".join(out) if k == len(pairs) else None


# ------------------------------------------------------------------ page
def _page(root, doc) -> tuple[str, dict[str, Any]]:
    body = root.find(_w("body"))
    sect = body.find(_w("sectPr")) if body is not None else None
    w_t, h_t = 11906, 16838  # A4
    mar = {"top": 1440, "right": 1440, "bottom": 1440, "left": 1440}
    borders: dict[str, dict] = {}
    offset_from = "text"
    page_bidi = False
    if sect is not None:
        sz = sect.find(_w("pgSz"))
        if sz is not None:
            w_t = min(max(_int(sz.get(_w("w")), w_t) or w_t, 2000), 60_000)
            h_t = min(max(_int(sz.get(_w("h")), h_t) or h_t, 2000), 60_000)
        pm = sect.find(_w("pgMar"))
        if pm is not None:
            for k in mar:
                mar[k] = min(max(_int(pm.get(_w(k)), mar[k]) or 0, 0), w_t // 2)
        pb = sect.find(_w("pgBorders"))
        if pb is not None:
            borders = parse_borders(pb)
            offset_from = pb.get(_w("offsetFrom"), "text")
        page_bidi = sect.find(_w("bidi")) is not None
    width_pt, height_pt = w_t / 20, h_t / 20
    props = [
        ("width", f"{width_pt:g}pt"),
        ("min-height", f"{height_pt:g}pt"),
        ("padding", " ".join(_pt(mar[k]) for k in ("top", "right", "bottom", "left"))),
        ("box-sizing", "border-box"),
    ]
    border_div = ""
    if any(borders.get(s, {}).get("val") not in (None, "nil", "none") for s in borders):
        ins = {}
        for side in ("top", "right", "bottom", "left"):
            b = borders.get(side)
            space = min(_int((b or {}).get("space"), 24) or 0, 31)
            ins[side] = space if offset_from == "page" else max(mar[side] / 20 - space, 0)
        bprops = [("position", "absolute"), ("pointer-events", "none")]
        order = ("top", "right", "bottom", "left")
        bprops.append(("inset", " ".join(f"{ins[s]:g}pt" for s in order)))
        for side in ("top", "right", "bottom", "left"):
            v = _border(borders.get(side))
            if v:
                bprops.append((f"border-{side}", v))
        border_div = f'<div class="dp-pageborder" style="{_css(bprops)}"></div>'
    info = {"width_pt": width_pt, "height_pt": height_pt, "bidi": page_bidi}
    return (
        f'<div class="dp-page" dir="{"rtl" if page_bidi else "ltr"}" style="{_css(props)}">'
        + border_div,
        info,
    )


def _marked(text: str | None) -> bool:
    return bool(text) and any(c in MARKS for c in text)


def render_docx(src, stored: str | None = None) -> dict[str, Any]:
    """Blocking. `src`: path of an already-guarded .docx (see `service.open_source`)."""
    from app.docx.service import open_source  # lazy: circular import

    doc = open_source(src)
    name = doc.part.partname.lstrip("/")
    try:
        with zipfile.ZipFile(src) as zin:
            root = parse_xml(zin.read(name))
    except (KeyError, etree.XMLSyntaxError, zipfile.BadZipFile) as exc:
        raise docx_corrupt(str(exc)) from exc
    mapping = None
    if stored is not None and stored.strip():
        from app.docx.stored import apply_stored  # lazy: circular import

        # the SAME tree the export writes (service.process_docx -> stored.apply_stored)
        mapping = apply_stored(root, stored)
    st = Styles(doc)
    rd = Renderer(doc, st)
    rd.diacritized = bool(mapping and mapping["applied"] and _marked(stored))
    head, info = _page(root, doc)
    body = root.find(_w("body"))
    inner = rd.block_children(body) if body is not None else ""
    return {
        "html": head + inner + "</div>",
        "page": info,
        "stats": {
            "paragraphs": rd.paragraphs,
            "images": rd.images,
            "skipped_images": rd.skipped_images,
            "truncated": rd.truncated,
            "diacritics": mapping,
        },
        "source": "docx",
    }


def render_text(text: str, font: str = "Amiri", size_px: int = 20) -> dict[str, Any]:
    """Document without a source .docx: one RTL paragraph per line using the editor font."""
    family = _font_css(font, True)
    pt = round(size_px * 0.75 * 2) / 2
    paras = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")[:MAX_PARAGRAPHS]:
        paras.append(
            f'<p dir="rtl" style="text-align:start;margin:0 0 {pt * 0.6:g}pt 0;'
            f'line-height:1.9;font-family:{family};font-size:{pt:g}pt">'
            f"{html.escape(line) or '&#8203;'}</p>"
        )
    props = "width:595.3pt;min-height:841.9pt;padding:72pt 72pt 72pt 72pt;box-sizing:border-box"
    return {
        "html": f'<div class="dp-page" dir="rtl" style="{props}">' + "".join(paras) + "</div>",
        "page": {"width_pt": 595.3, "height_pt": 841.9, "bidi": True},
        "stats": {"paragraphs": len(paras), "images": 0, "skipped_images": 0,
                  "truncated": False, "diacritics": None},  # fmt: skip
        "source": "text",
    }
