"""Automatic case data card («بطاقة القضية»).

Rule-based extraction of the case number/year, case type, court and circuit, session dates,
parties (with roles and «بصفته» capacities) and the requested relief. Everything is a
suggestion with a confidence in [0, 1]; positions are code-point offsets into the original
text. The text is never modified.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from app.legal.scan import DateRef, Folded, find_dates, read_words

# ------------------------------------------------------------------ case numbers
_KW = r"(?:ال)?(?:دعوي|دعاوي|قضيه|طعن|استيناف|جنحه|جنايه|مخالفه|اشكال|تظلم|معارضه|التماس)"
_STOP_MID = r"(?:قانون|القانون|لايحه|اللايحه|قرار|القرار|ماده|المواد|رقم|برقم|رقمي)"
CASE_REF = re.compile(
    rf"(?<![ء-ي])(?P<pre>[بلوف]?)(?P<kind>{_KW})"
    rf"(?P<mid>(?:\s+(?!{_STOP_MID}(?![ء-ي]))[ء-ي]+){{0,3}}?)"
    r"\s+(?:رقم|برقم|رقمي)\s*(?P<no>\d{1,7})"
    r"(?:\s*/\s*(?P<yr2>(?:19|20)\d\d)(?!\d)"
    r"|\s*(?:لسنه|لعام|سنه)\s*(?P<yr>\d{1,4})(?!\d)(?:\s*(?P<q>ق(?:ضا[ء-ي]*)?(?![ء-ي])))?)"
)
_PRECEDENT = re.compile(r"(?:حكم|نقض|قضت|قضاء|حكمت|بجلسه|المبدا|قاعده)\s*[ء-ي\s]{0,25}$")
_KIND_TYPE = {
    "استيناف": "استئناف", "طعن": "طعن", "جنحه": "جنحة", "جنايه": "جناية",
    "مخالفه": "مخالفة", "اشكال": "إشكال", "تظلم": "تظلم", "معارضه": "معارضة",
    "التماس": "التماس",
}  # fmt: skip

_TYPE_COMPOUND = re.compile(
    r"(?<![ء-ي])(?:ال)?(?:مدني|مدنيه|تجاري|تجاريه|اداري|اداريه|اقتصادي|اقتصاديه|جنائي|جنائيه|"
    r"عمالي|عماليه|ايجارات|مستعجل|مستعجله)\s*(?:ال)?"
    r"(?:كلي|جزيي|كليه|جزييه|مستانف|مستانفه|ابتدايي|ابتداييه|عالي|عليا)(?![ء-ي])"
)
_TYPE_SINGLE = re.compile(
    r"(?<![ء-ي])(?:جنح(?:ه)?(?:\s+مستانف(?:ه)?)?|جنايات|مخالفات|استيناف\s+عالي|نقض|"
    r"احوال\s+شخصيه|دستوريه\s+عليا|اداريه\s+عليا|قضاء\s+اداري|مستعجل|اسره)(?![ء-ي])"
)
_NEAR = 90

_COURT = re.compile(r"(?<![ء-ي])[بلوف]?(?P<c>محكمه)(?![ء-ي])")
_COURT_STOP = {
    "في", "جلسه", "بجلسه", "رقم", "لسنه", "بتاريخ", "الموقره", "المصريه", "دايره", "الدايره",
    "حيث", "ان", "التي", "الذي", "ومقرها", "و", "ضد", "وذلك", "ثم", "علي", "من", "فقد", "قد",
    "اذ", "قضت", "حكمت", "اصدرت", "الماثله", "المختصه", "اول", "ثاني", "هذه", "هذا",
    "الموضوع", "الدرجه", "المحكمه", "الي", "الى", "عن", "ما", "قررت", "اودعت", "المنعقده",
}  # fmt: skip
_COURT_TERMINAL = {
    "الكليه", "الجزييه", "الابتداييه", "الاقتصاديه", "الاداريه", "الاداري", "العليا", "النقض",
    "الدستوريه", "الاسره", "الجنح", "الجنايات", "العماليه", "التجاريه", "المدنيه",
    "المستانفه",
}  # fmt: skip

_CIRCUIT = re.compile(r"(?<![ء-ي])[بلوف]?(?P<c>(?:ال)?دايره)(?![ء-ي])")
_CIRCUIT_STOP = {
    "في", "جلسه", "بجلسه", "رقم", "المنعقده", "المنعقد", "برياسه", "برئاسه", "المشكله",
    "بتاريخ", "حيث", "ان", "و", "علي", "من", "التي", "الموقره", "ضد", "وذلك", "الماثله",
    "المختصه", "اصدرت", "ثم", "قضت", "حكمت", "فقد", "قد", "اذ", "ب", "ل",
}  # fmt: skip
_ORD = {
    "اول", "اولي", "ثاني", "ثانيه", "ثالث", "ثالثه", "رابع", "رابعه", "خامس", "خامسه", "سادس",
    "سادسه", "سابع", "سابعه", "ثامن", "ثامنه", "تاسع", "تاسعه", "عاشر", "عاشره",
}  # fmt: skip
_CIRCUIT_TYPES = {
    "مدني", "مدنيه", "جنح", "جنايات", "ايجارات", "تجاري", "تجاريه", "عمال", "عماليه",
    "اسره", "اداري", "اداريه", "اقتصاديه", "مستعجل", "مستانف", "مستانفه", "كلي", "جزيي",
}  # fmt: skip

_SESSION = re.compile(r"(?<![ء-ي])(?:[بلوف]|وب|ول)?(?:ال)?جلسه(?![ء-ي])")
_SESSION_WORD = re.compile(r"[ \t]*[ء-ي]+")

# ------------------------------------------------------------------ parties
_ROLE_DEFS: list[tuple[str, str, str]] = [
    # (regex on folded text, canonical label, side)
    (r"مدعي\s+بالحق\s+المدني", "المدعي بالحق المدني", "plaintiff"),
    (r"مدعي\s+علي(?:ه|ها|هم|هما)", "المدعى عليه", "defendant"),
    (r"مدعي(?:ه|ين|ان|ون)?", "المدعي", "plaintiff"),
    (r"مطعون\s+ضد(?:ه|ها|هم|هما)?", "المطعون ضده", "defendant"),
    (r"طاعن(?:ه|ين|ان|ون)?", "الطاعن", "plaintiff"),
    (r"مستانف\s+ضد(?:ه|ها|هم|هما)?", "المستأنف ضده", "defendant"),
    (r"مستانف(?:ه|ين|ان|ون)?", "المستأنف", "plaintiff"),
    (r"معارض\s+ضد(?:ه|ها|هم|هما)?", "المعارض ضده", "defendant"),
    (r"معارض(?:ه|ين|ان|ون)?", "المعارض", "plaintiff"),
    (r"مستشكل\s+ضد(?:ه|ها|هم|هما)?", "المستشكل ضده", "defendant"),
    (r"مستشكل(?:ه|ين|ان|ون)?", "المستشكل", "plaintiff"),
    (r"متظلم\s+ضد(?:ه|ها|هم|هما)?", "المتظلم ضده", "defendant"),
    (r"متظلم(?:ه|ين|ان|ون)?", "المتظلم", "plaintiff"),
    (r"ملتمس\s+ضد(?:ه|ها|هم|هما)?", "الملتمس ضده", "defendant"),
    (r"ملتمس(?:ه|ين|ان|ون)?", "الملتمس", "plaintiff"),
    (r"مطلوب\s+ضد(?:ه|ها|هم|هما)?", "المطلوب ضده", "defendant"),
    (r"مجني\s+علي(?:ه|ها|هم|هما)", "المجني عليه", "plaintiff"),
    (r"متهم(?:ه|ين|ان|ون)?", "المتهم", "defendant"),
]  # fmt: skip
_ROLE_RE = "|".join(f"(?:{p})" for p, _, _ in _ROLE_DEFS)
_ROLE_COMPILED = [(re.compile(p + r"(?![ء-ي])"), lab, side) for p, lab, side in _ROLE_DEFS]
_ORD_RE = r"(?:\s+(?:ال)?(?:اول|ثاني|ثالث|رابع|خامس|سادس|سابع|ثامن|تاسع|عاشر)[هي]?)?"
_BULLET = r"(?:\d+[ \t]*[-.)][ \t]*|[-•*]+[ \t]*)?"
_LABEL_LINE = re.compile(
    rf"(?m)^[ \t]*{_BULLET}(?:ال)?(?P<role>{_ROLE_RE})(?![ء-ي])(?P<ord>{_ORD_RE})"
    r"[ \t]*(?:[:：/]|[ \t]-[ \t])[ \t]*(?P<rest>[^\n]*)"
)
_BASIFA = re.compile(r"(?<![ء-ي])(?:بصفته|بصفتها|بصفتهم|بصفتهما)(?![ء-ي])")
_NAME_CUT = re.compile(
    r"[ \t]+(?:و?(?:ال)?(?:مقيم|مقيمه|مقيمين|ساكن|قاطن|محله|محلهم|موطنه|موطنهم|عنوانه|الكاين|الساكن|"
    r"يعلن|المحامي|وكيله|وكيلها)(?![ء-ي]))|[،,(]"
)
_HONORIFIC = re.compile(
    r"^(?:(?:ال)?(?:سيد|سيده|سيدين|سادم?ه?|استاذ|استاذه|دكتور|دكتوره|مهندس|مستشار)[ \t]*[/:.]?[ \t]*)+"
)
_LINE_ROLE_END = re.compile(
    rf"[ \t]*[(\-–:]?[ \t]*(?:ال)?(?P<role>{_ROLE_RE})(?![ء-ي])(?P<ord>{_ORD_RE})[ \t]*\)?[ \t]*[.،,:]?[ \t]*$"
)
_RELIEF_H1 = re.compile(
    r"(?m)^[ \t]*(?:\d+[ \t]*[-.)][ \t]*)?(?:(?:اولا|ثانيا|ثالثا|رابعا)[ \t]*[:\-]?[ \t]*)?"
    r"(?:ال)?طلبات(?:[ \t]+[ء-ي]+){0,2}[ \t]*[:：\-]?"
)
_RELIEF_H2 = re.compile(
    r"(?<![ء-ي])(?:و|ف)?(?:بناء[ \t]+علي[ه]|لذلك|لهذه[ \t]+الاسباب|ولما[ \t]+تقدم|"
    r"ولما[ \t]+كان[ \t]+ذلك|يلتمس|تلتمس|نلتمس|نطلب|اطلب)(?![ء-ي])"
)
_SIGN_LINE = re.compile(
    r"(?m)^[ \t]*(?:وكيل(?:[ \t]+ال[ء-ي]+)?|المحامي|الاستاذ|وتفضلوا|توقيع|مقدمه|وكيل)(?![ء-ي])"
)
_MAX_RELIEF = 2000


@dataclass
class Item:
    start: int
    end: int
    text: str
    confidence: float
    extra: dict[str, Any]

    def out(self) -> dict[str, Any]:
        return {"start": self.start, "end": self.end, "text": self.text,
                "confidence": round(self.confidence, 2), **self.extra}  # fmt: skip


def find_case_refs(F: Folded) -> list[dict[str, Any]]:
    """Every «الدعوى/الطعن … رقم N لسنة Y» reference, in document order."""
    out = []
    f = F.f
    for m in CASE_REF.finditer(f):
        yr = m.group("yr2") or m.group("yr")
        q = bool(m.group("q"))
        s, e = F.span(m.start("kind"), m.end())
        no = m.group("no")
        calendar_year = len(yr) == 4 and not q
        text = f"{int(no)} لسنة {yr}" + (" ق" if q else "")
        before = f[max(0, m.start() - 40) : m.start()]
        out.append(
            {
                "fs": m.start("kind"), "fe": m.end(), "start": s, "end": e, "number": int(no),
                "year": int(yr), "year_text": yr, "judicial": q, "calendar_year": calendar_year,
                "kind": m.group("kind").removeprefix("ال"), "text": text,
                "precedent": bool(_PRECEDENT.search(before)),
                "present": bool(re.search(r"(?:الماثله|المطروحه|الراهنه|الحاليه)", m.group("mid"))),
            }
        )  # fmt: skip
    return out


def find_sessions(F: Folded, dates: list[DateRef] | None = None) -> list[tuple[DateRef, int]]:
    """Dates introduced by «جلسة»; returns (date, folded index of «جلسة»)."""
    f = F.f
    by_start = {d.fs: d for d in (dates if dates is not None else find_dates(F))}
    out = []
    for m in _SESSION.finditer(f):
        pos = m.end()
        for _ in range(4):  # «جلسة يوم الخميس الموافق 30/7/2026»: up to 3 filler words
            while pos < len(f) and f[pos] in " \t":
                pos += 1
            if pos in by_start:
                out.append((by_start[pos], m.start()))
                break
            w = _SESSION_WORD.match(f, pos)
            if not w:
                break
            pos = w.end()
    return out


def _occurrences(F: Folded, pattern: str, limit: int = 30) -> list[dict[str, int]]:
    occ = []
    for m in re.finditer(pattern, F.f):
        s, e = F.span(m.start(), m.end())
        occ.append({"start": s, "end": e})
        if len(occ) >= limit:
            break
    return occ


def _field(key: str, label: str, value: str, conf: float, start: int, end: int, **kw: Any) -> dict:
    return {"key": key, "label_ar": label, "value": value, "confidence": round(conf, 2),
            "start": start, "end": end, **kw}  # fmt: skip


# ------------------------------------------------------------------ extractors
def _case_number(F: Folded, refs: list[dict[str, Any]]) -> tuple[dict | None, dict | None]:
    if not refs:
        return None, None

    def score(r: dict[str, Any]) -> float:
        c = 0.95 if r["fs"] < 700 else 0.85 if r["fs"] < 2500 else 0.75
        if r["precedent"]:
            c -= 0.3
        if r["judicial"] or r["calendar_year"]:
            c += 0.0
        else:
            c -= 0.15  # two-digit year without «ق»: ambiguous
        return c

    best = max(refs, key=lambda r: (score(r), -r["fs"]))
    pat = rf"(?<!\d){best['number']}\s*(?:/|لسنه|لعام|سنه)\s*{best['year_text']}(?!\d)"
    occ = _occurrences(F, pat)
    fld = _field(
        "case_number", "رقم الدعوى", best["text"], score(best), best["start"], best["end"],
        occurrences=occ, number=best["number"], year=best["year"], judicial_year=best["judicial"],
    )  # fmt: skip
    return fld, best


def _case_type(F: Folded, best: dict[str, Any] | None) -> dict | None:
    f = F.f
    cands: list[tuple[float, int, int, str]] = []
    if best:
        lo, hi = max(0, best["fs"] - _NEAR), min(len(f), best["fe"] + _NEAR)
        win = f[lo:hi]
        for rx in (_TYPE_COMPOUND, _TYPE_SINGLE):
            for m in rx.finditer(win):
                cands.append((0.92, lo + m.start(), lo + m.end(), m.group(0)))
        # «مدني» next to the reference without a second word («الدعوى المدنية رقم …»)
        mid = re.search(
            r"(?<![ء-ي])(?:ال)?(مدني|مدنيه|تجاري|تجاريه|جنائي|جنائيه|اداري|اداريه|عمالي|عماليه)(?![ء-ي])",
            win,
        )
        if mid and not cands:
            cands.append((0.8, lo + mid.start(), lo + mid.end(), mid.group(0)))
        if not cands:
            word = _KIND_TYPE.get(best["kind"])
            if word:
                return _field("case_type", "نوع الدعوى", word, 0.7, best["start"], best["end"])
    if not cands:
        for m in _TYPE_COMPOUND.finditer(f[:2000]):
            cands.append((0.55, m.start(), m.end(), m.group(0)))
    if not cands:
        return None
    conf, fs, fe, _ = max(cands, key=lambda c: (c[0], -c[1]))
    s, e = F.span(fs, fe)
    raw = F.raw(fs, fe)
    folded = f[fs:fe]
    occ = _occurrences(F, re.escape(folded).replace(r"\ ", r"\s+"))
    return _field("case_type", "نوع الدعوى", raw, conf, s, e, occurrences=occ)


def _court(F: Folded) -> dict | None:
    f = F.f
    best: tuple[float, int, int, int, bool] | None = None
    for m in _COURT.finditer(f):
        words, end = read_words(f, m.end(), 5, _COURT_STOP, _COURT_TERMINAL)
        if not words or any(w.isdigit() for w in words[:1]):
            continue
        terminal = words[-1] in _COURT_TERMINAL
        conf = 0.9 if terminal else 0.65
        conf += 0.05 if m.start() < 1200 else -0.1
        if _PRECEDENT.search(f[max(0, m.start() - 40) : m.start()]):
            conf -= 0.25
        cand = (conf, m.start("c"), end, m.start(), terminal)
        if best is None or cand[0] > best[0] + 1e-9:
            best = cand
    if best is None:
        return None
    conf, fs, fe, _, _ = best
    s, e = F.span(fs, fe)
    occ = _occurrences(F, re.escape(f[fs:fe]).replace(r"\ ", r"\s+"))
    return _field("court", "المحكمة", F.raw(fs, fe), min(conf, 0.98), s, e, occurrences=occ)


def _circuit(F: Folded) -> dict | None:
    f = F.f
    best = None
    for m in _CIRCUIT.finditer(f):
        words, end = read_words(f, m.end(), 3, _CIRCUIT_STOP)
        if not words:
            continue
        w0 = words[0].removeprefix("ال")
        if w0.isdigit() or w0 in _ORD:
            conf = 0.88
        elif w0 in _CIRCUIT_TYPES:
            conf = 0.8
        else:
            conf = 0.55
        # keep the ordinal (+ optional type word) only: «الدائرة الثالثة مدني كلي»
        keep = [words[0]]
        for w in words[1:]:
            if w.removeprefix("ال") in _CIRCUIT_TYPES | _ORD or w.isdigit():
                keep.append(w)
            else:
                break
        _, kend = read_words(f, m.end(), len(keep), _CIRCUIT_STOP)
        fs = m.start("c")
        cand = (conf + (0.04 if m.start() < 1500 else 0), fs, kend)
        if best is None or cand[0] > best[0] + 1e-9:
            best = cand
    if best is None:
        return None
    conf, fs, fe = best
    s, e = F.span(fs, fe)
    return _field("circuit", "الدائرة", F.raw(fs, fe), min(conf, 0.95), s, e)


def _sessions(F: Folded, dates: list[DateRef]) -> dict | None:
    items: list[Item] = []
    seen: set[tuple[int, int]] = set()
    for d, _ in find_sessions(F, dates):
        s, e = F.span(d.fs, d.fe)
        if (s, e) in seen:
            continue
        seen.add((s, e))
        problem = d.problem()
        items.append(
            Item(s, e, F.raw(d.fs, d.fe), 0.5 if problem else 0.95,
                 {"iso": d.as_iso(), "valid": problem is None})
        )  # fmt: skip
    if not items:
        return None
    return _field(
        "session_dates", "تواريخ الجلسات", "، ".join(i.text for i in items),
        min(i.confidence for i in items) if len(items) == 1 else max(i.confidence for i in items),
        items[0].start, items[0].end, items=[i.out() for i in items],
    )  # fmt: skip


def _clean_name(F: Folded, fs: int, fe: int) -> tuple[int, int, int | None]:
    """Trim a folded name range: honorifics, residence clauses; returns (fs, fe, basifa_start)."""
    f = F.f
    seg = f[fs:fe]
    cut = _NAME_CUT.search(seg)
    bas = _BASIFA.search(seg)
    basifa = None
    end = len(seg)
    if bas:
        basifa = fs + bas.start()
        end = bas.start()
    if cut and cut.start() < end:
        end = cut.start()
    seg_n = seg[:end].rstrip(" \t:-–/.")
    start = 0
    lead = len(seg_n) - len(seg_n.lstrip(" \t:-–/"))
    start = lead
    h = _HONORIFIC.match(seg_n[start:])
    if h and len(seg_n[start + h.end() :].strip()) >= 2:
        start += h.end()
    return fs + start, fs + len(seg_n), basifa


def _capacity(F: Folded, bas_fs: int, line_end: int) -> str:
    f = F.f
    m = _BASIFA.match(f, bas_fs)
    if not m:
        return ""
    tail_fs = m.end()
    tail = f[tail_fs:line_end]
    r = _LINE_ROLE_END.search(tail)
    if r:
        tail = tail[: r.start()]
    tail = re.sub(r"[ \t]*[.،,:]\s*$", "", tail)
    cut = _NAME_CUT.search(tail)
    if cut and cut.start() > 0:
        tail = tail[: cut.start()]
    if not tail.strip():
        return ""
    return F.raw(tail_fs, tail_fs + len(tail))


def _role_of(text: str) -> tuple[str, str] | None:
    for rx, label, side in _ROLE_COMPILED:
        m = rx.match(text)
        if m:
            return label, side
    return None


def _parties(F: Folded) -> dict | None:
    f = F.f
    items: list[Item] = []
    taken: list[tuple[int, int]] = []

    def free(a: int, b: int) -> bool:
        return not any(a < y and x < b for x, y in taken)

    def add(role: str, side: str, role_text: str, fs: int, fe: int, basifa: int | None,
            line_end: int, conf: float) -> None:  # fmt: skip
        if fe - fs < 2 or not free(fs, fe):
            return
        s, e = F.span(fs, fe)
        name = F.raw(fs, fe)
        cap = _capacity(F, basifa, line_end) if basifa is not None else ""
        taken.append((fs, fe))
        text = f"{role}: {name}" + (f" (بصفته {cap})" if cap else "")
        items.append(Item(s, e, text, conf,
                          {"role": role, "side": side, "role_text": role_text, "name": name,
                           "capacity": cap or None}))  # fmt: skip

    # 1) «المدعي: …» label lines (name on the same line or the next non-empty one)
    for m in _LABEL_LINE.finditer(f):
        role = m.group("role")
        rl = _role_of(role)
        if not rl:
            continue
        rest_fs, rest_fe = m.start("rest"), m.end("rest")
        if not f[rest_fs:rest_fe].strip():
            nxt = re.compile(r"\s*\n[ \t]*(?:\d+[ \t]*[-.)][ \t]*)?([^\n]+)").match(f, m.end())
            if not nxt:
                continue
            rest_fs, rest_fe = nxt.start(1), nxt.end(1)
            if _LABEL_LINE.match(f, nxt.start(1)):
                continue
        fs, fe, bas = _clean_name(F, rest_fs, rest_fe)
        add(rl[0], rl[1], F.raw(m.start("role"), m.end("role") + len(m.group("ord"))),
            fs, fe, bas, rest_fe, 0.9 if len(f[fs:fe]) <= 70 else 0.75)  # fmt: skip
    # 2) «السيد/ فلان وآخرين بصفتهم مدعى عليهم»
    for m in _BASIFA.finditer(f):
        ls = max(f.rfind("\n", 0, m.start()) + 1, f.rfind(".", 0, m.start()) + 1)
        le = f.find("\n", m.end())
        le = len(f) if le == -1 else le
        head = f[ls : m.start()]
        if re.search(rf"(?:ال)?(?:{_ROLE_RE})(?![ء-ي])\s*[:：/]", head):
            continue  # already a label line
        stripped = re.sub(rf"^[ \t]*{_BULLET}", "", head)
        lead = len(head) - len(stripped)
        starts_sayed = bool(_HONORIFIC.match(stripped))
        if len(stripped) > 110 or len(stripped.strip()) < 2:
            continue
        tail = f[m.end() : le]
        direct = re.match(rf"[ \t]*(?:ال)?(?P<role>{_ROLE_RE})(?![ء-ي])", tail)
        endm = _LINE_ROLE_END.search(tail)
        role_m = direct or endm
        if not role_m and not starts_sayed:
            continue
        if role_m:
            rl = _role_of(re.sub(r"^ال", "", role_m.group("role")))
        else:
            rl = None
        fs, fe, _ = _clean_name(F, ls + lead, m.start())
        if rl:
            add(rl[0], rl[1], F.raw(m.end() + role_m.start("role"), m.end() + role_m.end("role")),
                fs, fe, m.start(), le, 0.85 if direct else 0.78)  # fmt: skip
        else:
            add("", "", "", fs, fe, m.start(), le, 0.5)
    # 3) «السيد/ فلان … مدعي» (role at the end of an address line)
    for m in re.finditer(
        r"(?m)^[ \t]*" + _BULLET + r"(?:ال)?(?:سيد|سيده|سيدين|سادم?ه?)[ \t]*/[^\n]{2,200}$", f
    ):
        line = m.group(0)
        endm = _LINE_ROLE_END.search(line)
        if not endm:
            continue
        rl = _role_of(re.sub(r"^ال", "", endm.group("role")))
        if not rl:
            continue
        body_fs = m.start()
        fs, fe, bas = _clean_name(F, body_fs, m.start() + endm.start())
        add(rl[0], rl[1], F.raw(m.start() + endm.start("role"), m.start() + endm.end("role")),
            fs, fe, bas, m.end(), 0.7)  # fmt: skip
    if not items:
        return None
    items.sort(key=lambda i: i.start)
    conf = max(i.confidence for i in items)
    value = "\n".join(i.text for i in items)
    return _field("parties", "الأطراف", value, conf, items[0].start, items[0].end,
                  items=[i.out() for i in items])  # fmt: skip


def _relief(F: Folded) -> dict | None:
    f = F.f
    h1 = [m for m in _RELIEF_H1.finditer(f) if len(f[m.start() : m.end()].strip()) <= 40]
    chosen = None
    conf = 0.0
    for m in reversed(h1):
        if len(f) - m.start() <= 6000:
            chosen, conf = (m.start(), m.end()), 0.92
            break
    if chosen is None:
        for m in reversed(list(_RELIEF_H2.finditer(f))):
            if len(f.strip()) - m.end() >= 12:
                chosen, conf = (m.start(), m.end()), 0.7
                break
    if chosen is None:
        return None
    start, body_start = chosen
    end = min(len(f), start + _MAX_RELIEF)
    sign = _SIGN_LINE.search(f, body_start, end)
    if sign:
        end = sign.start()
    while end > body_start and f[end - 1].isspace():
        end -= 1
    if end - body_start < 6:
        return None
    # the value is the body (without the heading), shown with the original spelling
    s, e = F.span(start, end)
    bs, _ = F.span(body_start, end)
    lines = [re.sub(r"[ \t]+", " ", ln).strip() for ln in F.text[bs:e].split("\n")]
    value = "\n".join(ln for ln in lines if ln).lstrip(":：- ").strip()
    return _field("relief", "الطلبات", value, conf, s, e)


# ------------------------------------------------------------------ public API
def extract_case_card(text: str) -> dict[str, Any]:
    """Fields found in `text`, each {key, label_ar, value, confidence, start, end, ...}."""
    F = Folded(text)
    dates = find_dates(F)
    refs = find_case_refs(F)
    num_field, best = _case_number(F, refs)
    fields: list[dict[str, Any]] = []
    if num_field:
        fields.append(num_field)
    for fld in (
        _case_type(F, best),
        _court(F),
        _circuit(F),
        _sessions(F, dates),
        _parties(F),
        _relief(F),
    ):
        if fld:
            fields.append(fld)
    return {
        "fields": fields,
        "count": len(fields),
        "other_case_refs": [
            {"start": r["start"], "end": r["end"], "text": r["text"]}
            for r in refs
            if best and r is not best and r["text"] != best["text"]
        ],
        "disclaimer_ar": "استخراج آلي تقريبي؛ راجع كل حقل قبل الاعتماد عليه.",
    }
