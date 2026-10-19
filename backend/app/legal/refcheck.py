"""Warnings for dates, case numbers, article references and law citations.

Suggestions only: every issue has an Arabic message and a position, nothing is rewritten. The
checks are heuristics, so each issue carries a rule id (the UI can mute a rule) and the
messages ask the user to verify instead of asserting an error.

Issue shape (like `lint`): {rule, type, severity, start, end, text, message_ar, message_en,
related?} with code-point offsets into the original text.
"""

from __future__ import annotations

import datetime as dt
import re
from typing import Any

from app.legal.casecard import find_case_refs, find_sessions
from app.legal.scan import HIJRI_SUFFIX, DateRef, Folded, find_dates, is_hijri_year

RULES: dict[str, dict[str, str]] = {
    "date_impossible": {"severity": "warning", "title_ar": "تاريخ غير ممكن"},
    "date_future": {"severity": "warning", "title_ar": "تاريخ مستقبلي لواقعة ماضية"},
    "session_before_filing": {"severity": "warning", "title_ar": "جلسة قبل رفع الدعوى"},
    "year_range_mismatch": {"severity": "warning", "title_ar": "تعارض سنة الدعوى ونطاق السنوات"},
    "calendar_format": {"severity": "warning", "title_ar": "تقويم لا يناسب السنة"},
    "case_number_inconsistent": {"severity": "warning", "title_ar": "رقم الدعوى غير متسق"},
    "article_malformed": {"severity": "warning", "title_ar": "صياغة رقم المادة"},
    "article_impossible": {"severity": "warning", "title_ar": "رقم مادة غير ممكن"},
    "article_inconsistent": {"severity": "warning", "title_ar": "رقم المادة غير متسق"},
    "law_number_inconsistent": {"severity": "warning", "title_ar": "رقم القانون وسنته غير متسقين"},
}

MAX_ARTICLE = 3000
MAX_SUB = 500


def _issue(F: Folded, rule: str, fs: int, fe: int, ar: str, en: str, **extra: Any) -> dict:
    s, e = F.span(fs, fe)
    return {"rule": rule, "type": rule, "severity": RULES[rule]["severity"], "start": s,
            "end": e, "text": F.text[s:e], "message_ar": ar, "message_en": en, **extra}  # fmt: skip


def _one_edit(a: str, b: str) -> bool:
    """Same length and differ by one digit or one adjacent transposition."""
    if len(a) != len(b) or a == b:
        return False
    diff = [i for i in range(len(a)) if a[i] != b[i]]
    if len(diff) == 1:
        return True
    return (
        len(diff) == 2
        and diff[1] == diff[0] + 1
        and a[diff[0]] == b[diff[1]]
        and a[diff[1]] == b[diff[0]]
    )


def _rel(F: Folded, fs: int, fe: int) -> dict[str, int]:
    s, e = F.span(fs, fe)
    return {"start": s, "end": e}


# ------------------------------------------------------------------ dates
_FUTURE_CUES = re.compile(
    r"(?<![ء-ي])(?:و|ف)?(?:سيتم|ستنظر|سوف|سيصدر|ستنتهي|تحدد|حدد|حددت|جلسه|ميعاد|موعد|يستحق|"
    r"ينتهي|تنتهي|اعتبارا|لحين|حتي|ليكون|تاجيل|اجل|ابتداء|يبدا|تبدا|مقرر|المقرر|المحدده|"
    r"المحدد|القادمه|الاتيه|التاليه|يسري|تسري|الي)(?![ء-ي])"
)
_PAST_CUES = re.compile(
    r"(?<![ء-ي])(?:و|ف)?(?:صدر|صدرت|حرر|حررت|تحرر|تحرير|تحريره|اقام|اقامت|اقيمت|اودع|اودعت|"
    r"اعلن|اعلنت|قضت|حكمت|توفي|توفيت|ابرم|ابرمت|وقع|وقعت|وقعا|ورد|تقدم|قدم|قدمت|ارتكب|"
    r"حدثت|حدث|قيدت|رفعت|رفع|استلم|استلمت|تسلم|تسلمت|دفع|دفعت|تم)(?![ء-ي])"
)


def _check_dates(F: Folded, dates: list[DateRef], today: dt.date, out: list[dict]) -> None:
    for d in dates:
        problem = d.problem()
        if problem:
            out.append(
                _issue(
                    F,
                    "date_impossible",
                    d.fs,
                    d.fe,
                    f"تاريخ غير ممكن: {problem}؛ راجع التاريخ.",
                    "Impossible date; please check day, month and year.",
                    reason=problem,
                )  # fmt: skip
            )
            continue
        iso = d.as_iso()
        if not iso:
            continue
        date = dt.date.fromisoformat(iso)
        if date <= today:
            continue
        ss, se = F.sentence(d.fs)
        before, sent = F.f[ss : d.fs], F.f[ss:se]
        if _FUTURE_CUES.search(sent) or not _PAST_CUES.search(before):
            continue
        out.append(
            _issue(
                F,
                "date_future",
                d.fs,
                d.fe,
                f"التاريخ {date.isoformat()} لم يأتِ بعد بينما الجملة تصف واقعة سابقة؛ راجع السنة.",
                "Date is in the future but the sentence describes a past event.",
                date=date.isoformat(),
            )  # fmt: skip
        )


_FILING = re.compile(r"(?<![ء-ي])(?:اودعت|اقيمت|رفعت|قيدت|مودعه|اقام|اودع|صحيفه|رفع)(?![ء-ي])")


def _check_sessions(F: Folded, dates: list[DateRef], refs: list[dict], out: list[dict]) -> None:
    sessions = find_sessions(F, dates)
    if not sessions:
        return
    session_ids = {id(d) for d, _ in sessions}
    cal = [r for r in refs if r["calendar_year"] and not r["precedent"]]
    filing_year = cal[0]["year"] if cal else None
    filing_date: DateRef | None = None
    for d in dates:
        if id(d) in session_ids or d.problem() or d.hijri:
            continue
        ss, se = F.sentence(d.fs)
        sent = F.f[ss:se]
        if _FILING.search(sent) and "بتاريخ" in F.f[ss : d.fs]:
            filing_date = d
            break
    for d, _ in sessions:
        if d.problem() or d.hijri:
            continue
        if filing_date is not None and (d.year, d.month, d.day) < (
            filing_date.year, filing_date.month, filing_date.day
        ):  # fmt: skip
            out.append(
                _issue(
                    F,
                    "session_before_filing",
                    d.fs,
                    d.fe,
                    "تاريخ الجلسة يسبق تاريخ رفع الدعوى المذكور في المستند؛ راجع التاريخين.",
                    "Session date is earlier than the filing date.",
                    related=_rel(F, filing_date.fs, filing_date.fe),
                )  # fmt: skip
            )
        elif filing_year is not None and d.year < filing_year:
            out.append(
                _issue(
                    F,
                    "session_before_filing",
                    d.fs,
                    d.fe,
                    f"سنة الجلسة {d.year} تسبق سنة الدعوى {filing_year}؛ راجع التاريخ.",
                    "Session year precedes the case year.",
                    related=_rel(F, cal[0]["fs"], cal[0]["fe"]),
                )  # fmt: skip
            )


_RANGE = re.compile(
    r"(?<![\d/.\-])((?:19|20)\d\d)[ \t]*[-–/][ \t]*((?:19|20)\d\d)(?![\d])(?![/\-.]\d)"
)
_YEAR_WORD = re.compile(
    r"(?:عام|سنه|للعام|للسنه|موازنه)(?:[ \t]+(?:ال)?[ء-ي]+){0,2}[ \t]*(?:من)?[ \t]*\(?$"
)


def _check_year_ranges(F: Folded, refs: list[dict], out: list[dict]) -> None:
    cal = [r for r in refs if r["calendar_year"] and not r["precedent"]]
    for m in _RANGE.finditer(F.f):
        line_start = F.f.rfind("\n", 0, m.start()) + 1
        if not _YEAR_WORD.search(F.f[max(line_start, m.start() - 40) : m.start()]):
            continue
        a, b = int(m.group(1)), int(m.group(2))
        if b <= a or b - a != 1:
            why = "السنة الثانية لا تلي الأولى" if b <= a else "نطاق السنوات غير متتالٍ"
            out.append(
                _issue(
                    F,
                    "year_range_mismatch",
                    m.start(),
                    m.end(),
                    f"{why} ({a} - {b})؛ العام القضائي أو المالي يتكوّن من سنتين متتاليتين.",
                    "Year range is not two consecutive years.",
                )  # fmt: skip
            )
            continue
        if cal and not any(a <= r["year"] <= b for r in cal):
            r = cal[0]
            out.append(
                _issue(
                    F,
                    "year_range_mismatch",
                    m.start(),
                    m.end(),
                    f"سنة الدعوى {r['year']} ({r['text']}) لا تقع ضمن النطاق {a} - {b}؛ راجع السنة.",
                    "Case year is outside the stated year range.",
                    related=_rel(F, r["fs"], r["fe"]),
                )  # fmt: skip
            )


_YEAR_CAL = re.compile(r"(?<![\d/.\-])(\d{4})[ \t]*(ه|م)(?![ء-ي])")


def _check_calendar(F: Folded, dates: list[DateRef], out: list[dict]) -> None:
    covered = [(d.fs, d.fe) for d in dates]

    def judge(year: int, mark: str, fs: int, fe: int) -> None:
        if mark == "g" and is_hijri_year(year):
            out.append(
                _issue(
                    F,
                    "calendar_format",
                    fs,
                    fe,
                    f"السنة {year} تبدو هجرية لكنها مقرونة بـ«م» (ميلادي)؛ هل تقصد «هـ»؟",
                    "A Hijri-looking year is marked Gregorian.",
                    year=year,
                )  # fmt: skip
            )
        elif mark == "h" and (1800 <= year <= 2200):
            out.append(
                _issue(
                    F,
                    "calendar_format",
                    fs,
                    fe,
                    f"السنة {year} تبدو ميلادية لكنها مقرونة بـ«هـ» (هجري)؛ هل تقصد «م»؟",
                    "A Gregorian-looking year is marked Hijri.",
                    year=year,
                )  # fmt: skip
            )
        elif mark == "h" and not (1300 <= year <= 1500):
            out.append(
                _issue(
                    F,
                    "calendar_format",
                    fs,
                    fe,
                    f"السنة {year} خارج النطاق الهجري المعتاد (1300–1500 هـ)؛ راجع التقويم.",
                    "Year is outside the usual Hijri range.",
                    year=year,
                )  # fmt: skip
            )

    for d in dates:
        if d.suffix:
            judge(d.year, d.suffix, d.fs, d.fe)
    for m in _YEAR_CAL.finditer(F.f):
        if any(a <= m.start() < b for a, b in covered):
            continue
        judge(int(m.group(1)), "h" if m.group(2) in HIJRI_SUFFIX else "g", m.start(), m.end())


# ------------------------------------------------------------------ case numbers
def _check_case_numbers(F: Folded, refs: list[dict], out: list[dict]) -> None:
    refs = [r for r in refs if not r["precedent"]]
    if len(refs) < 2:
        return
    first = refs[0]
    reported: set[int] = set()

    def report(r: dict, other: dict, why: str) -> None:
        if id(r) in reported:
            return
        reported.add(id(r))
        out.append(
            _issue(
                F,
                "case_number_inconsistent",
                r["fs"],
                r["fe"],
                f"رقم الدعوى «{r['text']}» {why} «{other['text']}» المذكور سابقاً؛ "
                "تأكد أنهما القضية نفسها أو صحّح الرقم.",
                "Case number differs from an earlier mention of the same case.",
                related=_rel(F, other["fs"], other["fe"]),
            )  # fmt: skip
        )

    def same_kind(a: dict, b: dict) -> bool:
        return a["kind"].removeprefix("ال")[:4] == b["kind"].removeprefix("ال")[:4]

    for i, r in enumerate(refs[1:], 1):
        for o in refs[:i]:
            if not same_kind(r, o) or (r["number"], r["year_text"], r["judicial"]) == (
                o["number"], o["year_text"], o["judicial"]
            ):  # fmt: skip
                continue
            if r["number"] == o["number"] and r["judicial"] == o["judicial"]:
                report(r, o, "يطابق الرقم نفسه لكن بسنة مختلفة عن")
            elif (
                o is first
                and r["year_text"] == o["year_text"]
                and r["judicial"] == o["judicial"]
                and _one_edit(str(r["number"]), str(o["number"]))
            ):
                report(r, o, "يختلف بخانة واحدة (خطأ مطبعي محتمل) عن")
        if (
            r["present"]
            and r is not first
            and (r["number"], r["year"]) != (first["number"], first["year"])
        ):
            report(r, first, "موصوف بأنه الدعوى الماثلة لكنه يخالف")


# ------------------------------------------------------------------ articles / laws
_ART = re.compile(
    r"(?<![ء-ي])[وبفك]?(?P<al>(?:لل|ال)?)(?P<w>ماده|مواد|مادتي|مادتين|مادتان)(?![ء-ي])(?P<gap>[ \t]*(?:رقم[ \t]*)?)"
    r"(?P<open>[(\[)]?)(?P<sp1>[ \t]*)"
    r"(?P<num>\d+(?:[ \t]*[/\\][ \t]*\d+){0,3})"
    r"(?P<bis>(?:[ \t]*مكرر[ا]?(?:[ \t]*\(?[ \t]*[ء-ي0-9][ \t]*\)?)?)?)"
    r"(?P<sp3>[ \t]*)(?P<close>[)\]]?)"
)
_ART_RANGE = re.compile(
    r"(?<![ء-ي])[وبفك]?(?:لل|ال)?(?:ماده|مواد)[ \t]*(?:من[ \t]*)?\(?[ \t]*(\d+)[ \t]*\)?[ \t]*"
    r"(?:الي|حتي|-|–)[ \t]*(?:(?:ال)?ماده[ \t]*)?\(?[ \t]*(\d+)(?!\d)"
)
_JUNK = r"(?:[ \t]*(?:مكرر|فقره|الفقره|بند|البند|حرف|و|[ء-ي]|\([ \t]*[ء-ي0-9]+[ \t]*\)|\d+|/)){0,6}"
_LAW_AFTER = re.compile(
    rf"^{_JUNK}[ \t]*[،,]?[ \t]*(?:من|في)[ \t]+(?:ال)?(?P<k>قانون|لايحه|دستور)(?![ء-ي])"
    r"(?P<rest>[ \t]+رقم[ \t]*\d+[ \t]*(?:لسنه|لعام|سنه)[ \t]*\d{1,4}|[ \t]+(?:ال)?[ء-ي]+)?"
)
_NASS = re.compile(
    r"^(?:[ \t]+[ء-ي]+){0,3}?[ \t]*[،,]?[ \t]*(?:والتي|التي|الذي|وهي)?[ \t]*(?:تنص|نصت|ينص|تقضي|قضت|تقرر|قررت|بقولها)"
    r"(?:[ \t]*(?:علي|بان|ان))?[ \t]*[:\"«»“”'\s]*"
)


def _law_key(k: str, rest: str) -> str | None:
    if k == "دستور":
        return "دستور"
    m = re.match(r"[ \t]*رقم[ \t]*(\d+)[ \t]*(?:لسنه|لعام|سنه)[ \t]*(\d{1,4})", rest)
    if m:
        return f"{'لائحة' if k == 'لايحه' else 'قانون'} {int(m.group(1))}/{m.group(2)}"
    m = re.match(r"[ \t]*(?:ال)?([ء-ي]+)", rest)
    if not m or m.group(1) == "رقم":
        return None
    return f"{'لائحة' if k == 'لايحه' else 'قانون'} {m.group(1).removeprefix('ال')}"


def _check_articles(F: Folded, out: list[dict]) -> None:
    f = F.f
    arts: list[dict[str, Any]] = []
    for m in _ART.finditer(f):
        num = m.group("num")
        op, cl = m.group("open"), m.group("close")
        fs = m.start("w") if m.group("al") == "لل" else m.start("al")
        fe = m.end() if cl else m.end("bis")
        parts = [int(p) for p in re.split(r"[ \t]*[/\\][ \t]*", num)]
        raw_parts = re.split(r"[ \t]*[/\\][ \t]*", num)
        shown = "/".join(str(int(p)) for p in raw_parts)
        bis = re.sub(r"\s+", " ", m.group("bis")).strip()
        good = f"{m.group('w')} ({shown}{' ' + bis if bis else ''})"
        good = good.replace("ماده", "المادة", 1) if m.group("w") == "ماده" else good
        problems: list[str] = []
        if op and (m.group("sp1") or (cl and m.group("sp3"))):
            problems.append("مسافات زائدة داخل القوسين")
        if re.search(r"[ \t][/\\]|[/\\][ \t]", num):
            problems.append("مسافات حول الشرطة المائلة")
        if "\\" in num:
            problems.append("شرطة مائلة معكوسة")
        if op in ("(", "[") and not cl:
            problems.append("قوس غير مغلق")
        elif op and cl and {"(": ")", "[": "]"}.get(op) != cl:
            problems.append("قوسان غير متطابقين")
        elif op == ")":
            problems.append("قوس مفتوح بالاتجاه المعاكس")
        if any(len(p) > 1 and p.startswith("0") for p in raw_parts):
            problems.append("صفر زائد في بداية الرقم")
        if problems:
            out.append(
                _issue(
                    F,
                    "article_malformed",
                    fs,
                    fe,
                    f"صياغة رقم المادة: {'، '.join(dict.fromkeys(problems))}؛ المقترح: «{good}».",
                    "Malformed article reference.",
                    suggestion=good,
                )  # fmt: skip
            )
        if parts[0] == 0 or any(p == 0 for p in parts[1:]):
            out.append(
                _issue(
                    F,
                    "article_impossible",
                    fs,
                    fe,
                    "رقم المادة أو الفقرة لا يمكن أن يكون صفراً.",
                    "Article or paragraph number cannot be zero.",
                )  # fmt: skip
            )
        elif parts[0] > MAX_ARTICLE or any(p > MAX_SUB for p in parts[1:]):
            out.append(
                _issue(
                    F,
                    "article_impossible",
                    fs,
                    fe,
                    f"رقم المادة {parts[0]} أكبر من أي مادة في القوانين المعتادة؛ راجع الرقم.",
                    "Article number is implausibly large.",
                )  # fmt: skip
            )
        tail = f[m.end() : m.end() + 120]
        law = _LAW_AFTER.match(tail)
        key = _law_key(law.group("k"), law.group("rest") or "") if law else None
        quote = None
        if law:
            lend = m.end() + law.end("k") + len(law.group("rest") or "")
            q = _NASS.match(f[lend : lend + 160])
            if q:
                words = re.findall(r"[ء-ي]+", f[lend + q.end() : lend + q.end() + 90])[:5]
                if len(words) >= 4:
                    quote = " ".join(words)
        arts.append({"fs": fs, "fe": fe, "main": raw_parts[0], "key": key, "quote": quote})
    for m in _ART_RANGE.finditer(f):
        a, b = int(m.group(1)), int(m.group(2))
        if a > b:
            out.append(
                _issue(
                    F,
                    "article_impossible",
                    m.start(),
                    m.end(),
                    f"ترتيب المواد معكوس: من المادة {a} إلى {b}؛ راجع الترتيب.",
                    "Article range is reversed.",
                )  # fmt: skip
            )
    by_law: dict[str, list[dict[str, Any]]] = {}
    for a in arts:
        if a["key"]:
            by_law.setdefault(a["key"], []).append(a)
    reported: set[int] = set()
    for key, items in by_law.items():
        quotes: dict[str, dict[str, Any]] = {}
        for a in items:
            if not a["quote"]:
                continue
            first = quotes.setdefault(a["quote"], a)
            if first["main"].lstrip("0") != a["main"].lstrip("0") and id(a) not in reported:
                reported.add(id(a))
                out.append(
                    _issue(
                        F,
                        "article_inconsistent",
                        a["fs"],
                        a["fe"],
                        f"النص المنقول نفسه نُسب إلى المادة {first['main']} ثم إلى المادة "
                        f"{a['main']} من {key.split(' ')[0]} {key.split(' ', 1)[1]}؛ تأكد من الرقم.",
                        "The same quoted provision is cited with different article numbers.",
                        related=_rel(F, first["fs"], first["fe"]),
                    )  # fmt: skip
                )
        seen: dict[str, dict[str, Any]] = {}
        for a in items:
            num = a["main"].lstrip("0")
            for other_num, o in seen.items():
                if (
                    len(num) >= 2
                    and num != other_num
                    and sorted(num) == sorted(other_num)
                    and id(a) not in reported
                ):
                    reported.add(id(a))
                    out.append(
                        _issue(
                            F,
                            "article_inconsistent",
                            a["fs"],
                            a["fe"],
                            f"المادة {num} والمادة {other_num} من {key.split(' ', 1)[1]} "
                            "رقمان متشابهان (قد يكون أحدهما مقلوباً)؛ تأكد أن كليهما مقصود.",
                            "Two article numbers of the same law look like a transposition.",
                            related=_rel(F, o["fs"], o["fe"]),
                            severity="info",
                        )  # fmt: skip
                    )
            seen.setdefault(num, a)


_LAW_REF = re.compile(
    r"(?<![ء-ي])[بلوف]?(?P<k>(?:ال)?(?:قرار[ \t]+بقانون|قرار|قانون|لايحه))(?![ء-ي])"
    r"(?P<mid>(?:[ \t]+(?!رقم(?![ء-ي]))[ء-ي]+){0,4}?)[ \t]+رقم[ \t]*(?P<n>\d{1,5})[ \t]*"
    r"(?:لسنه|لعام|سنه)[ \t]*(?P<y>\d{4})(?!\d)"
)


def _check_laws(F: Folded, out: list[dict]) -> None:
    seen: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for m in _LAW_REF.finditer(F.f):
        k = m.group("k").removeprefix("ال")
        cls = "law" if "قانون" in k else "decree" if k == "قرار" else "reg"
        seen.setdefault((cls, int(m.group("n"))), []).append(
            {"fs": m.start("k"), "fe": m.end(), "year": m.group("y"), "n": int(m.group("n"))}
        )
    for (_, n), refs in seen.items():
        first = refs[0]
        for r in refs[1:]:
            if r["year"] == first["year"]:
                continue
            y1, y2 = int(first["year"]), int(r["year"])
            if abs(y1 - y2) <= 3 or _one_edit(first["year"], r["year"]):
                out.append(
                    _issue(
                        F,
                        "law_number_inconsistent",
                        r["fs"],
                        r["fe"],
                        f"رقم القانون {n} ورد بسنة {r['year']} هنا وبسنة {first['year']} في موضع "
                        "سابق؛ تأكد من سنة الإصدار الصحيحة.",
                        "The same law number is cited with different years.",
                        related=_rel(F, first["fs"], first["fe"]),
                    )  # fmt: skip
                )


# ------------------------------------------------------------------ public API
def check_refs(
    text: str,
    today: dt.date | None = None,
    rules: list[str] | None = None,
    disabled: list[str] | None = None,
) -> dict[str, Any]:
    active = (set(rules) if rules else set(RULES)) - set(disabled or [])
    today = today or dt.date.today()
    F = Folded(text)
    dates = find_dates(F)
    refs = find_case_refs(F)
    issues: list[dict[str, Any]] = []
    _check_dates(F, dates, today, issues)
    _check_sessions(F, dates, refs, issues)
    _check_year_ranges(F, refs, issues)
    _check_calendar(F, dates, issues)
    _check_case_numbers(F, refs, issues)
    _check_articles(F, issues)
    _check_laws(F, issues)
    issues = [i for i in issues if i["rule"] in active]
    issues.sort(key=lambda i: (i["start"], i["rule"]))
    by_rule: dict[str, int] = {}
    for i in issues:
        by_rule[i["rule"]] = by_rule.get(i["rule"], 0) + 1
    return {
        "issues": issues,
        "count": len(issues),
        "by_rule": by_rule,
        "disclaimer_ar": "تنبيهات مساعدة لا تغيّر النص؛ راجعها بنفسك فقد تظهر إيجابيات كاذبة.",
    }
