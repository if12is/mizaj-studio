"""Defined terms & parties consistency (Task 7.10.4).

Detects definitions such as «ويُشار إليه فيما بعد بـ «الطرف الأول»» or «يُقصد بـ «العقار»»,
counts uses (hamza/diacritic/ta-marbuta/digit insensitive) and reports inconsistencies. The
checks are suggestions only - nothing is rewritten.
"""

from __future__ import annotations

import re
from typing import Any

from app.engine.normalize import strip_marks

_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_ORD_BY_NUM = {1: "اول", 2: "ثاني", 3: "ثالث", 4: "رابع", 5: "خامس", 6: "سادس", 7: "سابع",
               8: "ثامن", 9: "تاسع", 10: "عاشر"}  # fmt: skip
_ORD_NORM = {"اولي": "اول", "ثانيه": "ثاني", "ثالثه": "ثالث", "رابعه": "رابع", "خامسه": "خامس",
             "سادسه": "سادس", "سابعه": "سابع", "ثامنه": "ثامن", "تاسعه": "تاسع", "عاشره": "عاشر"}  # fmt: skip

QUOTES = "«»“”\"'‹›„‟"
_TERM = r"(?:«([^»]{1,60})»|“([^”]{1,60})”|\"([^\"]{1,60})\")"
_TRIGGER = (
    r"(?:ويُ?شار|يُ?شار|المُ?شار|ويُ?طلق|يُ?طلق|ويُ?سمّ?ى|يُ?سمّ?ى|ويُ?عرف|يُ?عرف|ويُ?قصد|يُ?قصد|" r"المقصود)"
)
_DEF_RE = re.compile(
    rf"(?P<trig>{_TRIGGER}[ً-ْ]*(?:\s+(?:إليهما|إليهم|إليهن|إليها|إليه|عليهم|عليها|عليه|"
    rf"به|بها|بهم|فيه|فيها|إليهن)[ً-ْ]*)?"
    rf"(?:\s+(?:فيما\s+بعد|فيما\s+يلي|اختصاراً|اختصارا|في\s+هذا\s+العقد))?"
    rf"(?:\s+(?:بـ|ب|باسم|بكلمة|بعبارة|بلفظ))?)\s*"
    rf"(?:(?P<q1>{_TERM})|(?P<bare>[ء-يً-ْ]+(?:\s+[ء-يً-ْ]+){{0,2}}))"
)
_TITLES = r"(?:السيد|السيدة|الأستاذ|الأستاذة|الدكتور|الدكتورة|شركة|مؤسسة|السادة)"
GENERIC_ROLES = [
    "الطرف الأول", "الطرف الثاني", "الطرف الثالث", "المؤجر", "المستأجر", "البائع", "المشتري",
    "الموكل", "الوكيل", "الكفيل", "الدائن", "المدين", "صاحب العمل", "العامل", "المقاول",
    "رب العمل", "المورد", "العميل",
]  # fmt: skip


def fold(s: str) -> str:
    """Matching key: no marks/tatweel/quotes, hamza & ya & ta-marbuta folded, ASCII digits."""
    s = strip_marks(s).replace("ـ", "").translate(_DIGITS)
    for a, b in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ٱ", "ا"), ("ى", "ي"), ("ة", "ه"), ("ؤ", "و"),
                 ("ئ", "ي")):  # fmt: skip
        s = s.replace(a, b)
    for q in QUOTES:
        s = s.replace(q, "")
    return re.sub(r"\s+", " ", s).strip()


def canon_term(term: str) -> str:
    """Canonical key; 'الطرف 1' == 'الطرف الأول'; leading 'ال' ignored."""
    words = fold(term).split(" ")
    out = []
    for w in words:
        if w.isdigit() and 1 <= int(w) <= 10:
            w = "ال" + _ORD_BY_NUM[int(w)]
        w = "ال" + _ORD_NORM.get(w[2:], w[2:]) if w.startswith("ال") else w
        out.append(w)
    key = " ".join(out)
    return key.removeprefix("ال") if key.startswith("ال") else key


def _folded_with_map(text: str) -> tuple[str, list[int]]:
    """Folded text plus, for each folded char, the index of its source char."""
    out: list[str] = []
    idx: list[int] = []
    for i, ch in enumerate(text):
        f = fold(ch) if ch.strip() else " "
        if ch in "ًٌٍَُِّْـ":
            continue
        for c in f or "":
            out.append(c)
            idx.append(i)
    return "".join(out), idx


def _term_regex(canon: str) -> re.Pattern[str]:
    def word_re(w: str) -> str:
        for n, o in _ORD_BY_NUM.items():
            if w in (o, "ال" + o):  # ordinal word or its digit form (الطرف 1)
                return rf"(?:(?:ال)?{o}|{n})"
        return re.escape(w)

    words = canon.split(" ")
    core = r"\s+".join(word_re(w) if i else r"(?:ال)?" + word_re(w) for i, w in enumerate(words))
    # attached particles: و ف ب ك ل + optional ال (لل = ل + ال)
    prefix = r"(?<![ء-ي])(?:و|ف)?(?:بال|كال|لل|ال|ب|ك|ل)?"
    return re.compile(prefix + core + r"(?![ء-ي])")


def _surface(text: str, start: int, end: int) -> str:
    return strip_marks(text[start:end]).strip()


def analyze_terms(text: str) -> dict[str, Any]:
    defs: list[dict[str, Any]] = []
    for m in _DEF_RE.finditer(text):
        raw = (
            next((g for g in (m.group(3), m.group(4), m.group(5)) if g), None)
            if m.group("q1")
            else None
        )
        if raw is None:
            raw = m.group("bare")
            if raw is None:
                continue
            # bare terms must look like a defined term: start with ال or be short
            raw = re.split(r"\s+(?:هو|هي|وهو|وهي|على|في|من)\b", raw)[0]
            if not (fold(raw).startswith("ال") or len(raw.split()) <= 2):
                continue
            t_start, t_end = m.start("bare"), m.start("bare") + len(raw)
        else:
            qm = re.search(re.escape(raw), text[m.start("q1") : m.end("q1")])
            t_start = m.start("q1") + (qm.start() if qm else 0)
            t_end = t_start + len(raw)
        term = raw.strip()
        if not term or not re.search("[ء-ي]", term):
            continue
        # definition context: from the previous sentence boundary to the trigger
        ctx_start = max(text.rfind(".", 0, m.start()), text.rfind("\n", 0, m.start()),
                        text.rfind("،", 0, m.start()) if False else -1) + 1  # fmt: skip
        context = text[max(ctx_start, m.start() - 200) : m.start()].strip(" ،(")
        defs.append({"term": term, "canon": canon_term(term), "start": t_start, "end": t_end,
                     "definition": context, "def_span": (m.start(), m.end())})  # fmt: skip

    folded, idx = _folded_with_map(text)
    issues: list[dict[str, Any]] = []
    terms: list[dict[str, Any]] = []
    seen_canon: dict[str, dict[str, Any]] = {}
    for d in defs:
        if d["canon"] in seen_canon:
            issues.append({"type": "duplicate_definition", "term": d["term"], "start": d["start"],
                           "end": d["end"], "message_ar": "المصطلح معرَّف أكثر من مرة.",
                           "message_en": "Term is defined more than once."})  # fmt: skip
            continue
        rx = _term_regex(d["canon"])
        uses = []
        for um in rx.finditer(folded):
            s, e = idx[um.start()], idx[um.end() - 1] + 1
            if d["def_span"][0] <= s < d["def_span"][1]:
                continue  # the definition itself
            uses.append({"start": s, "end": e, "text": text[s:e]})
        entry = {
            "term": d["term"],
            "canonical": d["canon"],
            "defined_at": {"start": d["start"], "end": d["end"]},
            "definition": d["definition"],
            "uses": len(uses),
            "use_positions": uses,
        }
        seen_canon[d["canon"]] = entry
        terms.append(entry)
        if not uses:
            issues.append({"type": "unused_definition", "term": d["term"], "start": d["start"],
                           "end": d["end"], "message_ar": f"المصطلح «{d['term']}» معرَّف ولا يُستخدم.",
                           "message_en": f"Defined term '{d['term']}' is never used."})  # fmt: skip
        # surface variants of the defined term (hamza / digit / spelling differences)
        want = strip_marks(re.sub(r"\s+", " ", d["term"])).strip()
        for u in uses:
            got = strip_marks(re.sub(r"\s+", " ", u["text"]))
            if want not in got and want.removeprefix("ال") not in got:
                issues.append({"type": "variant_form", "term": d["term"], "start": u["start"],
                               "end": u["end"], "found": u["text"], "suggestion": d["term"],
                               "message_ar": f"صيغة مختلفة للمصطلح «{d['term']}».",
                               "message_en": f"Different spelling of the defined term '{d['term']}'."})  # fmt: skip

    # generic role labels that are used but never defined
    defined = set(seen_canon)
    for role in GENERIC_ROLES:
        rc = canon_term(role)
        if rc in defined:
            continue
        m = _term_regex(rc).search(folded)
        if m:
            s, e = idx[m.start()], idx[m.end() - 1] + 1
            hint = [t["term"] for t in terms]
            issues.append({"type": "undefined_term", "term": role, "start": s, "end": e,
                           "defined_terms": hint,
                           "message_ar": f"«{role}» مستخدم دون تعريف" + (
                               "؛ المصطلحات المعرَّفة: " + "، ".join(hint) if hint else "."),
                           "message_en": f"'{role}' is used but not defined."})  # fmt: skip
    # several defined terms for the same party description
    by_def: dict[str, list[str]] = {}
    for t in terms:
        key = fold(t["definition"])[-60:]
        if key:
            by_def.setdefault(key, []).append(t["term"])
    for names in by_def.values():
        if len(names) > 1:
            issues.append({"type": "multiple_terms_for_party", "terms": names,
                           "message_ar": "أكثر من مصطلح لنفس الطرف: " + "، ".join(names),
                           "message_en": "More than one term defined for the same party."})  # fmt: skip
    # the same name written in different ways
    names: dict[str, set[str]] = {}
    for m in re.finditer(rf"{_TITLES}\s*[:/]?\s*((?:[ء-ي]+\s*){{2,3}})", strip_marks(text)):
        words = m.group(1).split()
        names.setdefault(" ".join(fold(w) for w in words[:2]), set()).add(" ".join(words[:2]))
    for variants in names.values():
        if len(variants) > 1:
            issues.append({"type": "name_variants", "variants": sorted(variants),
                           "message_ar": "اسم مكتوب بصيغ مختلفة: " + "، ".join(sorted(variants)),
                           "message_en": "The same name is written in different ways."})  # fmt: skip
    return {"terms": terms, "issues": issues}
