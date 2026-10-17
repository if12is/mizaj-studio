"""Arabic ordinals (with gender) and clause-numbering / cross-reference checks (Task 7.10.5).

Never auto-applies anything: renumbering is returned as a list of edits for the user to accept.
"""

from __future__ import annotations

import re
from typing import Any

from app.engine.normalize import has_arabic_letters, join_pairs, split_pairs, strip_marks

F, D, K, SH = "َ", "ُ", "ِ", "ّ"
NOM, ACC, GEN = "nominative", "accusative", "genitive"


def _end(case: str) -> str:
    return {NOM: D, ACC: F, GEN: K}[case]


def canon(text: str) -> str:
    return join_pairs(split_pairs(text))


# ------------------------------------------------------------------ ordinals
# definite masculine / feminine stems (without case ending)
_M = {1: "الْأَوَّل", 3: "الثَّالِث", 4: "الرَّابِع", 5: "الْخَامِس", 6: "السَّادِس",
      7: "السَّابِع", 8: "الثَّامِن", 9: "التَّاسِع", 10: "الْعَاشِر"}  # fmt: skip
_F = {2: "الثَّانِيَة", 3: "الثَّالِثَة", 4: "الرَّابِعَة", 5: "الْخَامِسَة", 6: "السَّادِسَة",
      7: "السَّابِعَة", 8: "الثَّامِنَة", 9: "التَّاسِعَة", 10: "الْعَاشِرَة"}  # fmt: skip
_TENS = {2: "الْعِشْر", 3: "الثَّلَاث", 4: "الْأَرْبَع", 5: "الْخَمْس", 6: "السِّتّ",
         7: "السَّبْع", 8: "الثَّمَان", 9: "التِّسْع"}  # fmt: skip


def _unit(n: int, fem: bool, case: str) -> str:
    """Definite ordinal 1-10 with its case ending."""
    if n == 1:
        return "الْأُولَى" if fem else "الْأَوَّل" + _end(case)
    if n == 2:
        if fem:
            return _F[2] + _end(case)
        return "الثَّانِيَ" if case == ACC else "الثَّانِي"
    return (_F[n] if fem else _M[n]) + _end(case)


def _compound_unit(n: int, fem: bool, case: str) -> str:
    """Unit part of 21-99 ("الْحَادِي وَ..."): 1 is الْحَادِي(ة), others as _unit."""
    if n == 1:
        if fem:
            return "الْحَادِيَة" + _end(case)
        return "الْحَادِيَ" if case == ACC else "الْحَادِي"
    return _unit(n, fem, case)


def ordinal(n: int, fem: bool = False, case: str = NOM, diacritized: bool = True) -> str:
    """Ordinal for 1..100: الْخَامِسُ / الْخَامِسَةُ، الْحَادِيَ عَشَرَ / الْحَادِيَةَ عَشْرَةَ،
    الْحَادِي وَالْعِشْرُونَ ... (masculine for بند/فصل/باب, feminine for مادة/فقرة)."""
    if not 1 <= n <= 100:
        raise ValueError("ordinal supports 1..100")
    if n == 100:
        text = "الْمِائَة" + _end(case)
    elif n <= 10:
        text = _unit(n, fem, case)
    elif n < 20:
        k = n - 10
        if fem:
            head = {1: "الْحَادِيَةَ", 2: "الثَّانِيَةَ"}.get(k) or _F[k] + F
            text = head + " عَشْرَةَ"
        else:
            head = {1: "الْحَادِيَ", 2: "الثَّانِيَ"}.get(k) or _M[k] + F
            text = head + " عَشَرَ"
    else:
        tens, unit = divmod(n, 10)
        t = _TENS[tens] + ("ُونَ" if case == NOM else "ِينَ")
        text = t if unit == 0 else f"{_compound_unit(unit, fem, case)} وَ{t}"
    return canon(text) if diacritized else strip_marks(text)


# ------------------------------------------------------------------ parsing ordinals
def _norm(t: str) -> str:
    t = strip_marks(t)
    for a, b in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ى", "ي"), ("ة", "ه")):
        t = t.replace(a, b)
    return t


_ORD_WORDS = {
    "الاول": 1, "الاولي": 1, "الثاني": 2, "الثانيه": 2, "الثالث": 3, "الثالثه": 3,
    "الرابع": 4, "الرابعه": 4, "الخامس": 5, "الخامسه": 5, "السادس": 6, "السادسه": 6,
    "السابع": 7, "السابعه": 7, "الثامن": 8, "الثامنه": 8, "التاسع": 9, "التاسعه": 9,
    "العاشر": 10, "العاشره": 10, "الحادي": 1, "الحاديه": 1,
    "العشرون": 20, "العشرين": 20, "الثلاثون": 30, "الثلاثين": 30, "الاربعون": 40,
    "الاربعين": 40, "الخمسون": 50, "الخمسين": 50, "الستون": 60, "الستين": 60,
    "السبعون": 70, "السبعين": 70, "الثمانون": 80, "الثمانين": 80, "التسعون": 90,
    "التسعين": 90, "المائه": 100, "المئه": 100,
}  # fmt: skip
_TEN = {"عشر", "عشره"}
_ADVERB = {"اولا": 1, "ثانيا": 2, "ثالثا": 3, "رابعا": 4, "خامسا": 5, "سادسا": 6, "سابعا": 7,
          "ثامنا": 8, "تاسعا": 9, "عاشرا": 10}  # fmt: skip
_TOKEN = re.compile(r"[ء-يً-ْ]+")


def parse_ordinal(text: str) -> int | None:
    """'الخامسة' -> 5, 'الحادي عشر' -> 11, 'الثانية والعشرون' -> 22; None if not an ordinal."""
    toks = [_norm(t) for t in _TOKEN.findall(text)]
    toks = [t[:-2] if t.endswith("اً") else t for t in toks]
    if not toks:
        return None
    if len(toks) == 1 and toks[0].rstrip("ا") + "ا" in _ADVERB:
        return _ADVERB[toks[0].rstrip("ا") + "ا"]
    total = unit = 0
    for t in toks:
        if t.startswith("و") and t[1:] in _ORD_WORDS:
            t = t[1:]
        if t in _TEN:
            if not unit:
                return None
            total, unit = total + unit + 10, 0
        elif t in _ORD_WORDS:
            v = _ORD_WORDS[t]
            if v >= 20:
                total, unit = total + v + unit, 0
            elif unit:
                return None
            else:
                unit = v
        else:
            return None
    return (total + unit) or None


# ------------------------------------------------------------------ clause structure
KINDS = {"بند": False, "مادة": True, "فصل": False, "باب": False, "فقرة": True}  # -> feminine?
_KIND_RE = "|".join(KINDS)
_KIND_NORM = {_norm(k): k for k in KINDS}
_DIG = "0-9٠-٩"
_AR_TO_INT = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_W = "[ء-يً-ْ]+"
_REF = re.compile(
    rf"(?P<kind>(?:ال)?(?:{_KIND_RE}))\s*"
    rf"(?:\(\s*(?P<paren>[{_DIG}]+)\s*\)|(?P<digits>[{_DIG}]+)|(?P<ord>{_W}(?:\s+{_W}){{0,3}}))"
)
_EXTERNAL = re.compile(r"^\s*(?:\S+\s+){0,2}?من\s+(?:ال)?(?:قانون|نظام|لائحة|دستور|اتفاقية)")
_RELATIVE = re.compile(rf"(?:ال)?(?:{_KIND_RE})\s+(?:السابق|اللاحق|التالي)[ةه]?")
_HEAD_PREFIX = {"", "-", "•", "*"}


def _find(text: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    pos = 0
    while True:
        m = _REF.search(text, pos)
        if not m:
            break
        pos = m.end()
        kind = _KIND_NORM.get(_norm(m.group("kind")).removeprefix("ال"))
        if kind is None:
            pos = m.start() + 1
            continue
        if m.group("paren") or m.group("digits"):
            grp = "paren" if m.group("paren") else "digits"
            number = int(m.group(grp).translate(_AR_TO_INT))
            nstart, nend, form = m.start(grp), m.end(grp), grp
        else:
            toks = list(_TOKEN.finditer(m.group("ord")))
            number, used = None, 0
            for k in range(len(toks), 0, -1):
                v = parse_ordinal(" ".join(t.group(0) for t in toks[:k]))
                if v is not None:
                    number, used = v, k
                    break
            if number is None:
                pos = m.end("kind")
                continue
            base = m.start("ord")
            nstart, nend, form = base + toks[0].start(), base + toks[used - 1].end(), "ordinal"
            pos = nend
        line_start = text.rfind("\n", 0, m.start()) + 1
        prefix = text[line_start : m.start()].strip()
        tail = m.end() if form == "paren" else nend  # skip the closing ")"
        after = text[tail : tail + 3].lstrip(" ")
        is_heading = prefix in _HEAD_PREFIX and (
            after[:1] in (":", "-", "–", "—", ".", "") or after[:1] == "\n"
        )
        out.append({
            "kind": kind, "number": number, "form": form, "start": m.start(), "end": nend,
            "num_start": nstart, "num_end": nend, "literal": text[nstart:nend],
            "is_heading": is_heading,
            "external": bool(_EXTERNAL.match(text[nend : nend + 60])),
        })  # fmt: skip
    return out


def _render(kind: str, n: int, like: str, form: str) -> str:
    if form in ("digits", "paren"):
        s = str(n)
        return (
            s.translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩"))
            if re.search("[٠-٩]", like)
            else s
        )
    marked = any(c in like for c in (F, D, K, SH))
    return ordinal(n, KINDS[kind], NOM, diacritized=marked)


def _issue(typ: str, item: dict[str, Any], ar: str, en: str, **extra: Any) -> dict[str, Any]:
    return {"type": typ, "kind": item["kind"], "number": item["number"], "start": item["start"],
            "end": item["end"], "message_ar": ar, "message_en": en, **extra}  # fmt: skip


def analyze_clauses(text: str) -> dict[str, Any]:
    items = _find(text)
    headings = [i for i in items if i["is_heading"]]
    refs = [i for i in items if not i["is_heading"] and not i["external"]]
    issues: list[dict[str, Any]] = []
    suggestions: list[dict[str, Any]] = []
    by_kind: dict[str, list[dict[str, Any]]] = {}
    for h in headings:
        by_kind.setdefault(h["kind"], []).append(h)

    new_number: dict[tuple[str, int], int] = {}  # (kind, old) -> new, only for unique old numbers
    for kind, hs in by_kind.items():
        counts: dict[int, int] = {}
        for h in hs:
            counts[h["number"]] = counts.get(h["number"], 0) + 1
        for idx, h in enumerate(hs):
            expected = idx + 1
            if counts[h["number"]] > 1:
                issues.append(_issue("duplicate_number", h, f"رقم مكرر لـ{kind}.",
                                     f"Duplicate {kind} number."))  # fmt: skip
            if h["number"] != expected:
                prev = hs[idx - 1]["number"] if idx else 0
                typ = "gap" if h["number"] > prev + 1 else "out_of_order"
                issues.append(_issue(typ, h, f"ترقيم غير متسلسل: المتوقع {expected}.",
                                     f"Numbering is not sequential: expected {expected}.",
                                     expected=expected))  # fmt: skip
                new = _render(kind, expected, h["literal"], h["form"])
                suggestions.append({"type": "renumber_heading", "kind": kind,
                                    "start": h["num_start"], "end": h["num_end"],
                                    "from": h["literal"], "insert": new, "to": new,
                                    "reason": f"{kind} {h['number']} -> {expected}"})  # fmt: skip
            if counts[h["number"]] == 1:
                new_number[(kind, h["number"])] = expected

    existing = {(k, h["number"]) for k, hs in by_kind.items() for h in hs}
    graph: dict[tuple[str, int], set[tuple[str, int]]] = {}
    for r in refs:
        target = (r["kind"], r["number"])
        if r["kind"] not in by_kind:
            continue  # the document has no headings of that kind: nothing to verify against
        owner = None
        for h in headings:
            if h["start"] < r["start"]:
                owner = h
        if target not in existing:
            issues.append(_issue("missing_reference", r, f"إحالة إلى {r['kind']} غير موجود.",
                                 f"Reference to a {r['kind']} that does not exist."))  # fmt: skip
            continue
        if owner is not None:
            graph.setdefault((owner["kind"], owner["number"]), set()).add(target)
        new = new_number.get(target)
        if new is not None and new != r["number"]:
            ins = _render(r["kind"], new, r["literal"], r["form"])
            suggestions.append({"type": "update_reference", "kind": r["kind"],
                                "start": r["num_start"], "end": r["num_end"], "from": r["literal"],
                                "insert": ins, "to": ins,
                                "reason": f"reference follows {r['kind']} {r['number']} -> {new}"})  # fmt: skip
        elif target not in new_number:
            issues.append(_issue("ambiguous_reference", r, "الإحالة تشير إلى رقم مكرر.",
                                 "Reference points to a duplicated number."))  # fmt: skip

    reported: set[tuple[str, int]] = set()
    for start in graph:
        stack, seen = list(graph[start]), set()
        while stack:
            node = stack.pop()
            if node == start:
                if start not in reported:
                    reported.add(start)
                    issues.append({"type": "circular_reference", "kind": start[0], "number": start[1],
                                   "message_ar": "إحالة دائرية بين البنود.",
                                   "message_en": "Circular cross-references."})  # fmt: skip
                break
            if node not in seen:
                seen.add(node)
                stack.extend(graph.get(node, ()))
    if suggestions:
        for m in _RELATIVE.finditer(text):
            issues.append({"type": "relative_reference", "start": m.start(), "end": m.end(),
                           "message_ar": "إحالة نسبية قد تتأثر بإعادة الترقيم؛ راجعها.",
                           "message_en": "Relative reference may change after renumbering."})  # fmt: skip
    suggestions.sort(key=lambda e: e["start"])
    keep = ("kind", "number", "form", "start", "end", "literal")
    return {
        "headings": [{k: h[k] for k in keep} for h in headings],
        "references": [{k: r[k] for k in keep} for r in refs],
        "issues": issues,
        "suggestions": suggestions,
    }


def apply_edits(text: str, edits: list[dict[str, Any]]) -> str:
    """Apply suggested edits (right to left). The service itself never does this."""
    for e in sorted(edits, key=lambda e: e["start"], reverse=True):
        text = text[: e["start"]] + e["insert"] + text[e["end"] :]
    return text


__all__ = ["analyze_clauses", "apply_edits", "has_arabic_letters", "ordinal", "parse_ordinal"]
