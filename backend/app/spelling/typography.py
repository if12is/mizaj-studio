"""7.9.6 Arabic typography normalizer (suggestions only; nothing is applied automatically).

Detects text pasted from web/PDF sources: kashida, presentation forms, Persian lookalike
letters, ZWNJ/ZWJ, NBSP and exotic spaces, optional digit-script unification and quote style.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Literal

from pydantic import BaseModel

from .text import Masker, OffsetMap

TATWEEL_RE = re.compile("ـ+")
_PRESENTATION = "ﭐ-﷿ﹰ-ﻼ"
# maximal run of Arabic-block + presentation-form chars that contains a presentation form (the
# naive `[run]*[pres][run]*` is O(n^2) on long runs without one)
_PRES_BLOCK_RUN = re.compile(f"[؀-ۿ{_PRESENTATION}]+")
_PRES_CHAR = re.compile(f"[{_PRESENTATION}]")


class _PresRuns:
    @staticmethod
    def finditer(text: str):
        for m in _PRES_BLOCK_RUN.finditer(text):
            if _PRES_CHAR.search(m.group()):
                yield m


PRES_RUN_RE = _PresRuns()
PERSIAN_MAP = {
    "ی": "ي",
    "ک": "ك",
    "ۀ": "ه",
    "ھ": "ه",
    "ە": "ه",
    "ں": "ن",
    "ۃ": "ة",
    "ې": "ي",
    "ێ": "ي",
    "ۍ": "ي",
    "ٹ": "ت",
}
# A Persian/Urdu "run" is a maximal Arabic-block run containing a PERSIAN_MAP letter. Matching the
# old pattern `[block]*[persian][block]*` rescans each run from every start (O(n^2) on long runs).
_BLOCK_RUN = re.compile("[؀-ۿ]+")
_PERSIAN_CHAR = re.compile("[" + "".join(PERSIAN_MAP) + "]")


def _persian_runs(text: str):
    for m in _BLOCK_RUN.finditer(text):
        if _PERSIAN_CHAR.search(m.group()):
            yield m
_PERSIAN_ONLY = re.compile("[\u067e\u0686\u0698\u06af\u06a4\u0679\u0688\u0691]")
ZW_RE = re.compile("[‌‍]")
ODD_SPACE_RE = re.compile("[  -   　]")
NUMBER_RE = re.compile(r"(?<![\w.])[0-9٠-٩۰-۹]+(?:[.,٫٬][0-9٠-٩۰-۹]+)*(?![\w])")
_IDENT_AROUND = re.compile(r"[A-Za-z_\-/\\@#]")
_TO_INDIC = str.maketrans("0123456789۰۱۲۳۴۵۶۷۸۹", "٠١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦٧٨٩")
_TO_WESTERN = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_AR_TO_PERSIAN_DIGIT = "۰۱۲۳۴۵۶۷۸۹"
MIN_ID_DIGITS = 9  # long digit runs (IBAN, case numbers, phones) are never converted

MSG = {
    "TYPO_TATWEEL": "تطويل (كشيدة) زائد؛ يُحذف عادةً من النص المنسوخ.",
    "TYPO_PRESENTATION_FORM": "أشكال عرض (Presentation Forms) من PDF أو ويب؛ تُحوَّل لأساسية.",
    "TYPO_PERSIAN_LETTER": "حرف فارسي/أردي مشابه (ی ک …) بدل الحرف العربي (ي ك).",
    "TYPO_ZERO_WIDTH": "حرف عرض صفري (ZWNJ/ZWJ) قد يُفسد البحث والتشكيل.",
    "TYPO_NBSP": "فراغ غير عادي (NBSP أو فراغ خاص)؛ يُستبدل بمسافة عادية.",
    "TYPO_DIGITS": "توحيد نظام الأرقام وفق الخيار المحدد.",
    "TYPO_QUOTES": "توحيد علامات الاقتباس إلى «».",
}
SEVERITY = {
    "TYPO_TATWEEL": "info",
    "TYPO_PRESENTATION_FORM": "warning",
    "TYPO_PERSIAN_LETTER": "warning",
    "TYPO_ZERO_WIDTH": "info",
    "TYPO_NBSP": "info",
    "TYPO_DIGITS": "info",
    "TYPO_QUOTES": "info",
}


class TypographyOptions(BaseModel):
    tatweel: bool = True
    presentation_forms: bool = True
    persian_letters: bool = True
    zero_width: bool = True
    nbsp: bool = True
    digits: Literal["keep", "arabic_indic", "western"] = "keep"
    quotes: Literal["keep", "guillemets"] = "keep"


def _edit(text, s, e, code, new, conf=0.9):
    return {
        "start": s,
        "end": e,
        "word": text[s:e],
        "code": code,
        "category": "typography",
        "severity": SEVERITY[code],
        "message_ar": MSG[code],
        "suggestions": [new],
        "confidence": conf,
    }


def check_typography(text: str, masker: Masker, opt: TypographyOptions | None = None) -> list[dict]:
    opt = opt or TypographyOptions()
    out: list[dict] = []

    def ok(s: int, e: int) -> bool:
        return not masker.overlaps(s, max(e, s + 1))

    if opt.tatweel:
        for m in TATWEEL_RE.finditer(text):
            # kashida between letters only (a lone ـ line/ornament is left alone)
            s, e = m.span()
            if s > 0 and e < len(text) and "ء" <= text[s - 1] <= "ي" and ok(s, e):
                out.append(_edit(text, s, e, "TYPO_TATWEEL", ""))
    if opt.presentation_forms:
        for m in PRES_RUN_RE.finditer(text):
            new = unicodedata.normalize("NFKC", m.group())
            if new != m.group() and ok(*m.span()):
                out.append(_edit(text, m.start(), m.end(), "TYPO_PRESENTATION_FORM", new, 0.95))
    if opt.persian_letters and not _PERSIAN_ONLY.search(text):  # whole text is not Persian/Urdu
        for m in _persian_runs(text):
            run = m.group()
            if not re.search("[ء-ي]", run) or not ok(*m.span()):
                continue  # purely Persian words are not "mistyped Arabic"
            new = "".join(PERSIAN_MAP.get(c, c) for c in run)
            out.append(_edit(text, m.start(), m.end(), "TYPO_PERSIAN_LETTER", new, 0.85))
    if opt.zero_width:
        for m in ZW_RE.finditer(text):
            if ok(*m.span()):
                out.append(_edit(text, m.start(), m.end(), "TYPO_ZERO_WIDTH", "", 0.7))
    if opt.nbsp:
        for m in ODD_SPACE_RE.finditer(text):
            if ok(*m.span()):
                out.append(_edit(text, m.start(), m.end(), "TYPO_NBSP", " ", 0.8))
    if opt.digits != "keep":
        table = _TO_INDIC if opt.digits == "arabic_indic" else _TO_WESTERN
        for m in NUMBER_RE.finditer(text):
            s, e = m.span()
            tok = m.group()
            new = tok.translate(table)
            if new == tok or not ok(s, e) or len(re.sub(r"\D", "", tok)) >= MIN_ID_DIGITS:
                continue
            if (s > 0 and _IDENT_AROUND.match(text[s - 1])) or (
                e < len(text) and _IDENT_AROUND.match(text[e])
            ):
                continue  # inside an identifier / date-like or code-like token
            if opt.digits == "arabic_indic":
                new = new.replace(".", "٫").replace(",", "٬")
            else:
                new = new.replace("٫", ".").replace("٬", ",")
            out.append(_edit(text, s, e, "TYPO_DIGITS", new, 0.7))
    if opt.quotes == "guillemets":
        for m in re.finditer(r'"([^"\n]{1,300}?)"|“([^”\n]{1,300}?)”', text):
            if ok(*m.span()):
                inner = m.group(1) if m.group(1) is not None else m.group(2)
                new = f"«{inner.strip()}»"
                out.append(_edit(text, m.start(), m.end(), "TYPO_QUOTES", new, 0.7))
    return out


def propose_edits(text: str, opt: TypographyOptions, protected=None) -> dict:
    masker = Masker(text, protected)
    edits = sorted(check_typography(text, masker, opt), key=lambda e: e["start"])
    om = OffsetMap(text)
    final, preview, last = [], [], 0
    for e in edits:
        if e["start"] < last:  # overlapping proposals: keep the first, drop the rest
            continue
        e["start16"], e["end16"] = om.to16(e["start"]), om.to16(e["end"])
        e["old"], e["new"] = e["word"], e["suggestions"][0]
        final.append(e)
        preview.append(text[last : e["start"]] + e["new"])
        last = e["end"]
    preview.append(text[last:])
    return {
        "edits": final,
        "preview": "".join(preview),  # a proposal only: nothing is stored or applied
        "applied": False,
        "stats": {"edits": len(final)},
    }
