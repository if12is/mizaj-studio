"""7.9.3 Arabic punctuation and spacing rules (deterministic, suggestion-only)."""

from __future__ import annotations

import re
from collections import Counter

from .text import AR_LETTER, Masker

AR_L = f"[{AR_LETTER}ً-ْٰ]"
_AR_BEFORE = re.compile(f"{AR_L}[ً-ْـٰ]*[ \t ]*$")
_AR_AFTER = re.compile(f"^[ \t ]*{AR_L}")

CLOSERS = "،؛؟!.:,;?)]}»”"
_SPACE_BEFORE = re.compile(r"(?<=\S)([ \t\u00a0]+)(?=[،؛؟!:,;?])")
_SPACE_BEFORE_DOT = re.compile(r"(?<=\S)([ \t ]+)(?=\.(?:\s|$))")
_NO_SPACE_AFTER = re.compile(rf"(?<={AR_L})([،؛؟!])(?={AR_L})")
_COLON_NO_SPACE = re.compile(rf"(?<={AR_L}):(?={AR_L})")
_DOUBLE_SPACE = re.compile(r"(?<=\S)( {2,})(?=\S)")
_OPEN_INNER = re.compile(r"([(\[«“])([ \t\u00a0]+)(?=[^\s)\]»”])")
_CLOSE_INNER = re.compile(r"(?<=\S)([ \t ]+)([)\]»”])")
_GLUE_OPEN = re.compile(rf"(?<={AR_L})\(")
_GLUE_CLOSE = re.compile(rf"\)(?={AR_L})")
_ASCII_QUOTE = re.compile(r'"([^"\n]{1,200}?)"')
_CURLY_QUOTE = re.compile(r"[“”]")
_BIDI = re.compile("[‎‏‪-‮⁦-⁩]")
_NUMBER = re.compile(r"[0-9٠-٩۰-۹]+(?:[.,٫٬][0-9٠-٩۰-۹]+)*")
_ARABIC_INDIC = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")
_WESTERN = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")

# (code, severity, message_ar)
MSG = {
    "PUNCT_LATIN_COMMA": ("warning", "فاصلة لاتينية داخل نص عربي؛ الأصح «،»."),
    "PUNCT_LATIN_SEMICOLON": ("warning", "فاصلة منقوطة لاتينية داخل نص عربي؛ الأصح «؛»."),
    "PUNCT_LATIN_QUESTION": ("warning", "علامة استفهام لاتينية داخل نص عربي؛ الأصح «؟»."),
    "PUNCT_SPACE_BEFORE": ("warning", "مسافة زائدة قبل علامة الترقيم."),
    "PUNCT_SPACE_AFTER_MISSING": ("warning", "تنقص مسافة بعد علامة الترقيم."),
    "PUNCT_DOUBLE_SPACE": ("info", "مسافات متتالية؛ يكفي فراغ واحد."),
    "PUNCT_BRACKET_SPACE": ("info", "مسافة زائدة داخل القوسين أو علامات الاقتباس."),
    "PUNCT_BRACKET_GLUE": ("info", "تنقص مسافة بين الكلمة والقوس."),
    "PUNCT_QUOTE_STYLE": (
        "info",
        "يُفضَّل استعمال علامتي الاقتباس العربيتين «» بدل الاقتباس المستقيم.",
    ),
    "PUNCT_BIDI_MARK": ("info", "علامة اتجاه غير مرئية (RLM/LRM) قد لا تكون مقصودة."),
    "PUNCT_MIXED_DIGITS": (
        "info",
        "تُستعمل في المستند الأرقام الهندية والغربية معاً؛ يُنصح بتوحيدها.",
    ),
}


def _issue(start: int, end: int, text: str, code: str, sugg: list[str], conf: float = 0.9):
    sev, msg = MSG[code]
    return {
        "start": start,
        "end": end,
        "word": text[start:end],
        "code": code,
        "category": "punctuation",
        "severity": sev,
        "message_ar": msg,
        "suggestions": sugg,
        "confidence": conf,
    }


def check_punctuation(text: str, masker: Masker) -> list[dict]:
    out: list[dict] = []

    def ok(s: int, e: int) -> bool:
        return not masker.overlaps(s, max(e, s + 1))

    # Latin marks inside Arabic context (not between digits, not in URLs)
    for i, ch in enumerate(text):
        if ch not in ",;?" or not ok(i, i + 1):
            continue
        before = text[max(0, i - 40) : i]
        after = text[i + 1 : i + 41]
        prev_ar = _AR_BEFORE.search(before) is not None
        next_ar = _AR_AFTER.search(after) is not None
        sp = " " if after[:1] and not after[:1].isspace() and after[:1] not in CLOSERS else ""
        if ch == ",":
            if before[-1:].isdigit() and after[:1].isdigit():
                continue
            if prev_ar:
                out.append(_issue(i, i + 1, text, "PUNCT_LATIN_COMMA", ["،" + sp]))
        elif ch == ";":
            if prev_ar:
                out.append(_issue(i, i + 1, text, "PUNCT_LATIN_SEMICOLON", ["؛" + sp]))
        elif prev_ar and (next_ar or after[:1] in ("", " ", "\n", "\r", ")", "»")):
            out.append(_issue(i, i + 1, text, "PUNCT_LATIN_QUESTION", ["؟" + sp]))

    for m in _SPACE_BEFORE.finditer(text):
        s, e = m.span(1)
        nxt = text[e]
        prv = text[s - 1]
        if nxt in ":" and prv.isdigit() and text[e + 1 : e + 2].isdigit():
            continue  # 10 : 30 style ratios/times
        if nxt in ")]}»”" and text[s - 1] in "([{«“":
            continue
        if not (ok(s, e)):
            continue
        # only inside Arabic-ish sentences, to leave English typography alone
        ctx = text[max(0, s - 30) : s]
        if not _AR_BEFORE.search(ctx.rstrip() + ""):
            if not _AR_AFTER.search(text[e + 1 : e + 30]):
                continue
        out.append(_issue(s, e, text, "PUNCT_SPACE_BEFORE", [""]))
    for m in _SPACE_BEFORE_DOT.finditer(text):
        s, e = m.span(1)
        if ok(s, e) and _AR_BEFORE.search(text[max(0, s - 30) : s]):
            out.append(_issue(s, e, text, "PUNCT_SPACE_BEFORE", [""]))

    for m in _NO_SPACE_AFTER.finditer(text):
        s, e = m.span(1)
        if ok(s, e):
            out.append(_issue(s, e, text, "PUNCT_SPACE_AFTER_MISSING", [m.group(1) + " "]))
    for m in _COLON_NO_SPACE.finditer(text):
        s, e = m.span()
        if ok(s, e):
            out.append(_issue(s, e, text, "PUNCT_SPACE_AFTER_MISSING", [": "]))

    for m in _DOUBLE_SPACE.finditer(text):
        s, e = m.span(1)
        if (
            ok(s, e)
            and _AR_BEFORE.search(text[max(0, s - 20) : s])
            or _AR_AFTER.search(text[e : e + 20])
        ):
            if ok(s, e):
                out.append(_issue(s, e, text, "PUNCT_DOUBLE_SPACE", [" "], 0.95))

    for m in _OPEN_INNER.finditer(text):
        s, e = m.span(2)
        if ok(s, e):
            out.append(_issue(s, e, text, "PUNCT_BRACKET_SPACE", [""]))
    for m in _CLOSE_INNER.finditer(text):
        s, e = m.span(1)
        if text[s - 1] in "([«“":  # empty pair or markdown checkbox "[ ]"
            continue
        if ok(s, e):
            out.append(_issue(s, e, text, "PUNCT_BRACKET_SPACE", [""]))
    for m in _GLUE_OPEN.finditer(text):
        s, e = m.span()
        if ok(s, e):
            out.append(_issue(s, e, text, "PUNCT_BRACKET_GLUE", [" ("], 0.6))
    for m in _GLUE_CLOSE.finditer(text):
        s, e = m.span()
        if ok(s, e):
            out.append(_issue(s, e, text, "PUNCT_BRACKET_GLUE", [") "], 0.6))

    for m in _ASCII_QUOTE.finditer(text):
        s, e = m.span()
        if ok(s, e) and re.search(AR_L, m.group(1)):
            out.append(
                _issue(s, e, text, "PUNCT_QUOTE_STYLE", ["«" + m.group(1).strip() + "»"], 0.6)
            )
    for m in _BIDI.finditer(text):
        s, e = m.span()
        out.append(_issue(s, e, text, "PUNCT_BIDI_MARK", [""], 0.4))

    # numerals: mixed Arabic-Indic and Western digits in one document
    nums = [m for m in _NUMBER.finditer(text) if ok(*m.span())]
    kinds = Counter()
    for m in nums:
        kinds["ar" if re.search("[٠-٩۰-۹]", m.group()) else "en"] += 1
    if len(kinds) == 2:
        major = "ar" if kinds["ar"] >= kinds["en"] else "en"
        for m in nums:
            is_ar = bool(re.search("[٠-٩۰-۹]", m.group()))
            if is_ar != (major == "ar"):
                new = (
                    m.group().translate(_ARABIC_INDIC)
                    if major == "ar"
                    else m.group().translate(_WESTERN)
                )
                out.append(_issue(m.start(), m.end(), text, "PUNCT_MIXED_DIGITS", [new], 0.5))
    return out
