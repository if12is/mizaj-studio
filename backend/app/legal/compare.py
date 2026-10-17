"""Contract comparison insensitive to diacritics, tatweel, hamza and digit script (Task 7.10.11).

Paragraph alignment first, then a word-level diff inside matched paragraphs (`difflib`). All
offsets refer to the *original* texts, so the UI can paint the changes on what the user wrote.
Words whose normalized keys are equal but whose spelling differs (marks, hamza, digit script)
are reported as `format_only` hunks, which a UI should hide by default.

Substantive categories: numbers, amounts, dates, parties, obligations, negation.
"""

from __future__ import annotations

import re
from difflib import SequenceMatcher
from typing import Any

from app.legal.defined_terms import GENERIC_ROLES, analyze_terms, canon_term, fold
from app.legal.tafqeet import is_number_token

_DIG = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_WORD = re.compile(r"(?:[ء-يً-ْٰ\w]+(?:[.,٫٬](?=[\d٠-٩])[\d٠-٩]+)*)")
_CURRENCY = re.compile(r"جنيه|ريال|درهم|دولار|دينار|يورو|EGP|SAR|AED|USD|ج\.م|ر\.س")
_DATE_CTX = re.compile(
    r"\d{1,4}\s*[/\-]\s*\d{1,2}\s*[/\-]\s*\d{1,4}|يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|"
    r"أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر|المحرم|صفر|ربيع|جمادى|رجب|شعبان|رمضان|"
    r"شوال|ذو\s+القعدة|ذو\s+الحجة|كانون|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين|هـ"
)
_OBLIGATION = {fold(x) for x in ("يلتزم", "تلتزم", "يلتزمان", "يلتزمون", "يجب", "يجوز", "يحق", "يحظر",
                                 "يمنع", "يتعين", "ملزم", "ملتزم", "يتوجب", "يمتنع", "يحرم",
                                 "ممنوع", "محظور", "يسمح", "يمكن", "يتحمل", "يتكفل", "يضمن",
                                 "تتحمل", "تضمن", "تتكفل")}  # fmt: skip
_NEGATION = {fold(x) for x in ("لا", "لم", "لن", "ليس", "ليست", "غير", "دون", "بدون", "عدم", "إلا")}

MAX_TEXT = 2_000_000


def key(tok: str) -> str:
    """Matching key of one word (never shown)."""
    return fold(tok.translate(_DIG)).replace(",", "").replace("٬", "").replace("٫", ".")


def _paragraphs(text: str) -> list[dict[str, Any]]:
    out, pos = [], 0
    for line in text.split("\n"):
        words = [{"text": m.group(0), "key": key(m.group(0)), "start": pos + m.start(),
                  "end": pos + m.end()} for m in _WORD.finditer(line)]  # fmt: skip
        words = [w for w in words if w["key"]]
        if words:
            out.append(
                {
                    "start": pos,
                    "end": pos + len(line),
                    "words": words,
                    "text": line,
                    "key": " ".join(w["key"] for w in words),
                }
            )
        pos += len(line) + 1
    return out


def _align_paragraphs(a: list[dict], b: list[dict]) -> list[tuple[int | None, int | None]]:
    sm = SequenceMatcher(None, [p["key"] for p in a], [p["key"] for p in b], autojunk=False)
    pairs: list[tuple[int | None, int | None]] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            pairs += [(i1 + k, j1 + k) for k in range(i2 - i1)]
        elif tag == "delete":
            pairs += [(i, None) for i in range(i1, i2)]
        elif tag == "insert":
            pairs += [(None, j) for j in range(j1, j2)]
        else:  # replace: monotonic greedy pairing by similarity
            j_cur = j1
            for i in range(i1, i2):
                best, best_r = None, 0.39
                for j in range(j_cur, j2):
                    r = SequenceMatcher(
                        None, a[i]["key"].split(), b[j]["key"].split(), autojunk=False
                    ).ratio()
                    if r > best_r:
                        best, best_r = j, r
                if best is None:
                    pairs.append((i, None))
                else:
                    pairs += [(None, j) for j in range(j_cur, best)]
                    pairs.append((i, best))
                    j_cur = best + 1
            pairs += [(None, j) for j in range(j_cur, j2)]
    return pairs


def _span(words: list[dict], i1: int, i2: int) -> tuple[int, int]:
    return words[i1]["start"], words[i2 - 1]["end"]


def compare_texts(a: str, b: str) -> dict[str, Any]:
    pa, pb = _paragraphs(a), _paragraphs(b)
    hunks: list[dict[str, Any]] = []
    aligned: list[dict[str, Any]] = []

    def add_hunk(
        kind: str, wa: list[dict], wb: list[dict], para: tuple[int | None, int | None]
    ) -> int:
        h: dict[str, Any] = {
            "index": len(hunks),
            "type": kind,
            "a_para": para[0],
            "b_para": para[1],
        }
        for side, ws in (("a", wa), ("b", wb)):
            if ws:
                s, e = ws[0]["start"], ws[-1]["end"]
                h[side] = {"start": s, "end": e, "text": (a if side == "a" else b)[s:e]}
            else:
                h[side] = None
        hunks.append(h)
        return h["index"]

    for ia, ib in _align_paragraphs(pa, pb):
        if ia is None:
            ws = pb[ib]["words"]
            idx = add_hunk("insert", [], ws, (None, ib))
            aligned.append({"status": "added", "a": None, "b": _pr(pb[ib]), "hunks": [idx]})
            continue
        if ib is None:
            ws = pa[ia]["words"]
            idx = add_hunk("delete", ws, [], (ia, None))
            aligned.append({"status": "removed", "a": _pr(pa[ia]), "b": None, "hunks": [idx]})
            continue
        wa, wb = pa[ia]["words"], pb[ib]["words"]
        sm = SequenceMatcher(None, [w["key"] for w in wa], [w["key"] for w in wb], autojunk=False)
        idxs: list[int] = []
        status = "equal"
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                k = 0
                while k < i2 - i1:
                    if wa[i1 + k]["text"] != wb[j1 + k]["text"]:
                        s = k
                        while k < i2 - i1 and wa[i1 + k]["text"] != wb[j1 + k]["text"]:
                            k += 1
                        idxs.append(
                            add_hunk(
                                "format_only", wa[i1 + s : i1 + k], wb[j1 + s : j1 + k], (ia, ib)
                            )
                        )
                        status = "format_only" if status == "equal" else status
                    else:
                        k += 1
                continue
            kind = {"delete": "delete", "insert": "insert", "replace": "replace"}[tag]
            idxs.append(add_hunk(kind, wa[i1:i2], wb[j1:j2], (ia, ib)))
            status = "changed"
        aligned.append({"status": status, "a": _pr(pa[ia]), "b": _pr(pb[ib]), "hunks": idxs})

    parties = _party_terms(a, b)
    substantive: list[dict[str, Any]] = []
    for h in hunks:
        if h["type"] == "format_only":
            h["categories"] = []
            continue
        cats = _classify(h, a, b, parties)
        h["categories"] = cats
        if cats:
            substantive.append({"hunk": h["index"], "categories": cats, "type": h["type"],
                                "a_text": h["a"]["text"] if h["a"] else "",
                                "b_text": h["b"]["text"] if h["b"] else ""})  # fmt: skip
    counts = {
        t: sum(1 for h in hunks if h["type"] == t)
        for t in ("insert", "delete", "replace", "format_only")
    }
    by_cat: dict[str, int] = {}
    for s in substantive:
        for c in s["categories"]:
            by_cat[c] = by_cat.get(c, 0) + 1
    return {
        "identical": not any(h["type"] != "format_only" for h in hunks),
        "hunks": hunks, "aligned": aligned, "counts": counts,
        "summary": {"substantive": substantive, "by_category": by_cat,
                    "words_a": sum(len(p["words"]) for p in pa), "words_b": sum(len(p["words"]) for p in pb)},
        "note_ar": "المقارنة تتجاهل التشكيل والتطويل والهمزات وشكل الأرقام؛ تغييرات الشكل فقط مصنّفة format_only.",
    }  # fmt: skip


def _pr(p: dict[str, Any]) -> dict[str, Any]:
    return {"start": p["start"], "end": p["end"], "text": p["text"]}


def _party_terms(a: str, b: str) -> set[str]:
    terms = {canon_term(r) for r in GENERIC_ROLES}
    for t in (a, b):
        terms |= {x["canon"] for x in analyze_terms(t)["terms"]}
    return terms


def _classify(h: dict[str, Any], a: str, b: str, parties: set[str]) -> list[str]:
    cats: list[str] = []
    toks: list[str] = []
    ctx = ""
    for side, src in (("a", a), ("b", b)):
        if h[side]:
            toks += _WORD.findall(h[side]["text"])
            s, e = h[side]["start"], h[side]["end"]
            ctx += " " + src[max(0, s - 40) : e + 40]
    ks = [key(t) for t in toks]
    has_digit = any(re.search(r"\d", k) for k in ks)
    has_numword = any(is_number_token(t) for t in toks)
    if has_digit or has_numword:
        if _CURRENCY.search(ctx):
            cats.append("amounts")
        elif has_digit and _DATE_CTX.search(ctx):
            cats.append("dates")
        else:
            cats.append("numbers")
    elif _DATE_CTX.search(" ".join(toks)):
        cats.append("dates")
    if any(k in _OBLIGATION for k in ks):
        cats.append("obligations")
    if any(k in _NEGATION for k in ks):
        cats.append("negation")
    joined = " " + " ".join(ks) + " "
    for p in parties:
        f = fold(p).removeprefix("ال")
        if f and re.search(r"(?<![ء-ي])(?:ال)?" + re.escape(f) + r"(?![ء-ي])", joined):
            cats.append("parties")
            break
    return cats
