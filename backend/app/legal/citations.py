"""Legal citations: articles, laws, decrees, appeals and Quran references (Task 7.10.9).

Detection + format normalization + consistency checks. Nothing is rewritten: every
normalization is returned as a suggestion. We never claim an article exists or is in force;
the optional user-maintained *law index* (`kind: "law-index"`, numbers/years/names/article
counts only - no legislative text is shipped) lets us flag an article number above the law's
article count. Quran citations are detected (and their surah/ayah range sanity-checked
against the fixed canon counts) but the verse text is never touched.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any

from app.legal.defined_terms import fold
from app.legal.numbering import ordinal, parse_ordinal

_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_D = "0-9٠-٩۰-۹"
_W = "[ء-يً-ْ]+"

INDEX_KIND = "law-index"
MAX_INDEX = 5000

LAW_KINDS = [
    "مرسوم بقانون",
    "مرسوم ملكي",
    "أمر ملكي",
    "قرار وزاري",
    "قرار جمهوري",
    "قرار رئيس مجلس الوزراء",
    "قانون اتحادي",
    "قانون",
    "نظام",
    "لائحة",
    "مرسوم",
    "قرار",
    "دستور",
    "اتفاقية",
    "تعليمات",
]
_KIND_ALT = "|".join(
    sorted((re.escape(k).replace(r"\ ", r"\s+") for k in LAW_KINDS), key=len, reverse=True)
)

# a law/decree reference:  [ال]kind [name words] [رقم] (num) [لسنة|لعام year]
_LAW = re.compile(
    rf"(?P<kind>(?:ال)?(?:{_KIND_ALT}))"
    rf"(?P<name>(?:\s+(?!رقم)(?!لسنة)(?!ال{{1}}صادر)(?!الصادر)(?!وتاريخ)(?!بتاريخ){_W}){{0,4}}?)"
    rf"(?:\s+رقم)?\s*\(?\s*(?P<num>(?:م\s*/\s*)?[{_D}]+(?:\s*/\s*[{_D}]+)?)\s*\)?"
    rf"(?:\s*(?:لسنة|لعام|سنة|عام)\s*\(?\s*(?P<year>[{_D}]{{2,4}})\s*\)?(?:\s*(?P<cal>هـ|ه|م)(?![ء-ي]))?)?"
    rf"(?:\s+وتاريخ\s+(?P<date>[{_D}]{{1,4}}\s*[/\-.]\s*[{_D}]{{1,2}}\s*[/\-.]\s*[{_D}]{{1,4}})(?:\s*(?P<dcal>هـ|ه|م)(?![ء-ي]))?)?"
)
_APPEAL = re.compile(
    rf"(?P<kind>الطعن|الدعوى|القضية|الاستئناف)\s+رقم\s*\(?\s*(?P<num>[{_D}]+)\s*\)?\s*"
    rf"(?:لسنة|لعام)\s*\(?\s*(?P<year>[{_D}]{{2,4}})\s*\)?\s*(?P<q>ق(?:ضائية)?\.?)?"
)
_ARTICLE = re.compile(
    rf"(?P<noun>(?:ال)?ماد[ةت][ينه]?)\s*"
    rf"(?:\(\s*(?P<paren>[{_D}]+)\s*\)|(?P<digits>[{_D}]+)|(?P<ord>{_W}(?:\s+{_W}){{0,3}}?))"
    rf"(?P<tail>(?:\s*\(\s*[{_D}]+\s*\)|\s+{_W}(?:\s+{_W})?)?)"
)
_BIS_RE = re.compile(r"^\s*(مكرر[اً]*|مكررة)(?:\s*\(\s*([ء-ي]|[0-9٠-٩]+)\s*\))?")
_BIS_WORDS = re.compile(r"(?<![ء-ي])(مكرر[اً]*|مكررة)(?![ء-ي])")
_OF_LAW = re.compile(rf"^\s*(?:،\s*)?(?:من|في|بـ|من\s+ال)\s*(?:ال)?(?=(?:{_KIND_ALT}))")
_INTERNAL = re.compile(
    r"^\s*(?:من|في)\s+(?:هذا|هذه|ال)\s*(?:العقد|الاتفاق|الاتفاقية|النظام الأساسي|اللائحة)"
)
_QURAN = re.compile(
    rf"(?:\[\s*(?:سورة\s+)?(?P<s1>{_W}(?:\s+{_W}){{0,2}}?)\s*[:：،]\s*(?P<a1>[{_D}]+)(?:\s*[-–ـ]\s*(?P<a1e>[{_D}]+))?\s*\]"
    rf"|\(\s*سورة\s+(?P<s2>{_W}(?:\s+{_W}){{0,2}}?)\s*[،,:]?\s*(?:الآية|آية|الاية|اية)\s*(?:رقم\s*)?(?P<a2>[{_D}]+)\s*\)"
    rf"|سورة\s+(?P<s3>{_W}(?:\s+{_W}){{0,2}}?)\s*[،,]?\s*(?:الآية|آية|الاية|اية)\s*(?:رقم\s*)?\(?(?P<a3>[{_D}]+)\)?)"
)

SURAHS: list[tuple[str, int]] = [
    ("الفاتحة", 7), ("البقرة", 286), ("آل عمران", 200), ("النساء", 176), ("المائدة", 120),
    ("الأنعام", 165), ("الأعراف", 206), ("الأنفال", 75), ("التوبة", 129), ("يونس", 109),
    ("هود", 123), ("يوسف", 111), ("الرعد", 43), ("إبراهيم", 52), ("الحجر", 99), ("النحل", 128),
    ("الإسراء", 111), ("الكهف", 110), ("مريم", 98), ("طه", 135), ("الأنبياء", 112), ("الحج", 78),
    ("المؤمنون", 118), ("النور", 64), ("الفرقان", 77), ("الشعراء", 227), ("النمل", 93),
    ("القصص", 88), ("العنكبوت", 69), ("الروم", 60), ("لقمان", 34), ("السجدة", 30), ("الأحزاب", 73),
    ("سبأ", 54), ("فاطر", 45), ("يس", 83), ("الصافات", 182), ("ص", 88), ("الزمر", 75),
    ("غافر", 85), ("فصلت", 54), ("الشورى", 53), ("الزخرف", 89), ("الدخان", 59), ("الجاثية", 37),
    ("الأحقاف", 35), ("محمد", 38), ("الفتح", 29), ("الحجرات", 18), ("ق", 45), ("الذاريات", 60),
    ("الطور", 49), ("النجم", 62), ("القمر", 55), ("الرحمن", 78), ("الواقعة", 96), ("الحديد", 29),
    ("المجادلة", 22), ("الحشر", 24), ("الممتحنة", 13), ("الصف", 14), ("الجمعة", 11),
    ("المنافقون", 11), ("التغابن", 18), ("الطلاق", 12), ("التحريم", 12), ("الملك", 30),
    ("القلم", 52), ("الحاقة", 52), ("المعارج", 44), ("نوح", 28), ("الجن", 28), ("المزمل", 20),
    ("المدثر", 56), ("القيامة", 40), ("الإنسان", 31), ("المرسلات", 50), ("النبأ", 40),
    ("النازعات", 46), ("عبس", 42), ("التكوير", 29), ("الانفطار", 19), ("المطففين", 36),
    ("الانشقاق", 25), ("البروج", 22), ("الطارق", 17), ("الأعلى", 19), ("الغاشية", 26),
    ("الفجر", 30), ("البلد", 20), ("الشمس", 15), ("الليل", 21), ("الضحى", 11), ("الشرح", 8),
    ("التين", 8), ("العلق", 19), ("القدر", 5), ("البينة", 8), ("الزلزلة", 8), ("العاديات", 11),
    ("القارعة", 11), ("التكاثر", 8), ("العصر", 3), ("الهمزة", 9), ("الفيل", 5), ("قريش", 4),
    ("الماعون", 7), ("الكوثر", 3), ("الكافرون", 6), ("النصر", 3), ("المسد", 5), ("الإخلاص", 4),
    ("الفلق", 5), ("الناس", 6),
]  # fmt: skip
_SURAH_KEY = {fold(n).removeprefix("ال"): i + 1 for i, (n, _) in enumerate(SURAHS)}
_SURAH_KEY.update(
    {
        "ال عمران": 3,
        "ال عمران ": 3,
        "الاسراء": 17,
        "بني اسرائيل": 17,
        "يسين": 36,
        "يس": 36,
        "السجده": 32,
        "الم السجده": 32,
        "الملك": 67,
        "غافر": 40,
        "المؤمن": 40,
    }
)


class IndexError_(ValueError):  # noqa: N801
    pass


def to_int(s: str) -> int:
    return int(s.translate(_DIGITS))


# ------------------------------------------------------------------ law index
def validate_index(data: Any) -> dict[str, Any]:
    """Validate/normalize a user law-index document. Raises IndexError_ on bad input."""
    if not isinstance(data, dict) or data.get("kind") != INDEX_KIND:
        raise IndexError_(f'expected {{"kind": "{INDEX_KIND}", "laws": [...]}}')
    laws = data.get("laws")
    if not isinstance(laws, list) or len(laws) > MAX_INDEX:
        raise IndexError_(f"laws must be a list (max {MAX_INDEX})")
    out = []
    for i, law in enumerate(laws):
        if not isinstance(law, dict):
            raise IndexError_(f"laws[{i}] must be an object")
        name = str(law.get("name") or "").strip()
        num = str(law.get("number") or "").strip().translate(_DIGITS)
        year = law.get("year")
        arts = law.get("articles")
        if not name and not num:
            raise IndexError_(f"laws[{i}] needs a name or a number")
        if year not in (None, "") and not (
            isinstance(year, int | str) and str(year).translate(_DIGITS).isdigit()
        ):
            raise IndexError_(f"laws[{i}].year must be a number")
        if arts not in (None, "") and (
            not isinstance(arts, int) or isinstance(arts, bool) or arts < 1 or arts > 5000
        ):
            raise IndexError_(f"laws[{i}].articles must be an integer 1..5000")
        aliases = law.get("aliases") or []
        if not isinstance(aliases, list) or not all(isinstance(a, str) for a in aliases):
            raise IndexError_(f"laws[{i}].aliases must be a list of strings")
        out.append({"name": name, "number": num, "year": int(str(year).translate(_DIGITS)) if year not in (None, "") else None,
                    "articles": arts or None, "aliases": [a.strip() for a in aliases if a.strip()],
                    "kind": str(law.get("law_kind") or "").strip()})  # fmt: skip
    return {"version": 1, "kind": INDEX_KIND, "laws": out}


def _find_law(index: dict[str, Any] | None, num: str, year: int | None, name: str) -> dict | None:
    if not index:
        return None
    fn = fold(name).removeprefix("ال").strip()
    for law in index["laws"]:
        if num and law["number"] == num and (year is None or law["year"] in (None, year)):
            return law
    if fn:
        for law in index["laws"]:
            names = [law["name"], *law["aliases"]]
            if any(fold(n).removeprefix("ال") == fn or fn in fold(n) for n in names if n):
                return law
    return None


# ------------------------------------------------------------------ formatting
def format_article(
    n: int, bis: str | None = None, sub: str | None = None, style: str = "paren"
) -> str:
    base = f"المادة ({n})" if style == "paren" else f"المادة {n}"
    if bis:
        base += " مكرراً" + (f" ({sub})" if sub else "")
    return base


def format_law(kind: str, name: str, num: str, year: int | None, cal: str | None = None) -> str:
    k = kind if kind.startswith("ال") else "ال" + kind
    out = f"{k} {name.strip()} " if name.strip() else f"{k} "
    out += f"رقم {num}"
    if year is not None:
        out += f" لسنة {year}" + (f" {'هـ' if cal in ('هـ', 'ه') else 'م'}" if cal else "")
    return re.sub(r"\s+", " ", out).strip()


def _plausible_year(year: int, cal: str | None) -> bool:
    now = _dt.date.today().year
    if cal in ("هـ", "ه") or 1300 <= year <= 1500 and cal is None:
        return 1300 <= year <= 1500
    return 1800 <= year <= now + 1


def _surface(s: str) -> str:
    return re.sub(r"\s+", " ", fold(s)).strip()


# ------------------------------------------------------------------ main analysis
def analyze_citations(text: str, index: dict[str, Any] | None = None, style: str = "paren") -> dict:
    laws: list[dict[str, Any]] = []
    for m in _LAW.finditer(text):
        num = m.group("num").translate(_DIGITS)
        year_s = m.group("year")
        year = to_int(year_s) if year_s else None
        name = " ".join(m.group("name").split())
        # the 'name' must not swallow an 'ال' article marker of the next clause
        kind = fold(m.group("kind")).removeprefix("ال")
        if (
            not name
            and not year
            and "رقم" not in text[m.start() : m.end()]
            and kind in ("قانون", "نظام", "قرار")
        ):
            continue  # "القانون 5 ..." without رقم/سنة is probably not a citation
        laws.append({
            "type": "law", "kind": kind, "name": name, "number": num, "year": year,
            "calendar": m.group("cal"), "date": m.group("date"), "start": m.start(), "end": m.end(),
            "text": text[m.start() : m.end()],
        })  # fmt: skip
    appeals = [{"type": "case", "kind": m.group("kind"), "number": m.group("num").translate(_DIGITS),
                "year": to_int(m.group("year")), "judicial": bool(m.group("q")), "start": m.start(),
                "end": m.end(), "text": m.group(0)} for m in _APPEAL.finditer(text)]  # fmt: skip

    articles: list[dict[str, Any]] = []
    for m in _ARTICLE.finditer(text):
        a = _article(m, text, laws)
        if a:
            articles.append(a)

    quran = _quran(text)
    issues: list[dict[str, Any]] = []
    suggestions: list[dict[str, Any]] = []
    now = _dt.date.today().year

    for lw in laws:
        if lw["year"] is not None and not _plausible_year(lw["year"], lw["calendar"]):
            issues.append(
                _i(
                    "implausible_year",
                    lw,
                    f"السنة {lw['year']} غير معقولة؛ قد يكون الرقم والسنة مقلوبين.",
                    f"Year {lw['year']} is implausible (number/year swapped?).",
                )
            )
        if (
            lw["year"] is None
            and lw["number"]
            and not lw["number"].startswith("م")
            and lw["kind"] != "قرار"
        ):
            issues.append(
                _i(
                    "missing_year",
                    lw,
                    "رقم القانون بلا سنة صدور.",
                    "Law number without a year.",
                    severity="info",
                )
            )
        std = format_law(lw["kind"], lw["name"], lw["number"], lw["year"], lw["calendar"])
        if _surface(std) != _surface(lw["text"]) and lw["year"] is not None:
            suggestions.append(
                {
                    "kind": "format_law",
                    "start": lw["start"],
                    "end": lw["end"],
                    "original": lw["text"],
                    "suggested": std,
                }
            )
        lw["normalized"] = std
        if index:
            found = _find_law(index, lw["number"], lw["year"], lw["name"])
            lw["in_index"] = bool(found)
            if found is None:
                issues.append(
                    _i(
                        "law_not_in_index",
                        lw,
                        "القانون غير موجود في الفهرس الذي استوردته.",
                        "Law not found in your law index.",
                        severity="info",
                    )
                )
            elif found["year"] and lw["year"] and found["year"] != lw["year"]:
                issues.append(
                    _i(
                        "year_mismatch_index",
                        lw,
                        f"الفهرس يذكر سنة {found['year']}.",
                        f"The index lists year {found['year']}.",
                        index_year=found["year"],
                    )
                )

    # same law, different years -> likely typo
    by_num: dict[tuple[str, str], set[int]] = {}
    for lw in laws:
        if lw["year"] is not None:
            by_num.setdefault((lw["kind"], lw["number"]), set()).add(lw["year"])
    for lw in laws:
        ys = by_num.get((lw["kind"], lw["number"]), set())
        if len(ys) > 1 and lw["year"] is not None:
            issues.append(
                _i(
                    "inconsistent_year",
                    lw,
                    f"نفس رقم القانون ورد بسنوات مختلفة: {sorted(ys)}.",
                    f"Same law number cited with different years: {sorted(ys)}.",
                    years=sorted(ys),
                )
            )
    # same law, several spellings
    surf: dict[tuple, dict[str, dict]] = {}
    for lw in laws:
        if lw["year"] is not None:
            surf.setdefault((lw["kind"], lw["number"], lw["year"]), {}).setdefault(
                _surface(lw["text"]), lw
            )
    for forms in surf.values():
        if len(forms) > 1:
            first = next(iter(forms.values()))
            issues.append(
                _i(
                    "variant_forms",
                    first,
                    "نفس القانون مكتوب بأكثر من صيغة؛ وحّد الصياغة.",
                    "The same law is cited in several formats; unify.",
                    severity="info",
                    variants=[v["text"] for v in forms.values()],
                )
            )

    heads = _article_headings(text)
    for a in articles:
        n = a["number"]
        if a.get("mismatch"):
            issues.append(
                _i(
                    "article_number_mismatch",
                    a,
                    f"رقم المادة بالأرقام ({a['digits']}) لا يطابق الحروف ({a['ordinal']}).",
                    "Article number in digits and in words disagree.",
                    digits=a["digits"],
                    ordinal=a["ordinal"],
                )
            )
        if n is None:
            continue
        std = format_article(n, a["bis"], a["sub"], style)
        if not a["noun"].startswith("ال"):
            std = std.removeprefix("ال")
        a["normalized"] = std
        if a["external"] and _surface(std) != _surface(a["text"]) and not a.get("mismatch"):
            suggestions.append(
                {
                    "kind": "format_article",
                    "start": a["start"],
                    "end": a["end"],
                    "original": a["text"],
                    "suggested": std,
                }
            )
        if n < 1 or n > 5000:
            issues.append(
                _i(
                    "article_out_of_range",
                    a,
                    "رقم المادة غير معقول.",
                    "Implausible article number.",
                )
            )
        if a["external"] and a.get("law") and index:
            found = _find_law(index, a["law"]["number"], a["law"]["year"], a["law"]["name"])
            if found and found["articles"] and n > found["articles"]:
                issues.append(
                    _i(
                        "article_exceeds_law",
                        a,
                        f"القانون في الفهرس به {found['articles']} مادة فقط.",
                        f"The law has only {found['articles']} articles in your index.",
                        article_count=found["articles"],
                    )
                )
        if (
            not a["external"]
            and a["internal_ok"]
            and heads
            and n not in heads
            and not a["is_heading"]
        ):
            issues.append(
                _i(
                    "missing_internal_target",
                    a,
                    "لا توجد مادة بهذا الرقم في هذه الوثيقة.",
                    "No article with this number in this document.",
                    severity="info",
                )
            )
    # duplicate article headings
    seen: dict[int, int] = {}
    for a in articles:
        if a["is_heading"] and a["number"] is not None and not a["bis"]:
            if a["number"] in seen:
                issues.append(
                    _i(
                        "duplicate_article_heading",
                        a,
                        "عنوان المادة مكرر.",
                        "Duplicate article heading.",
                    )
                )
            seen[a["number"]] = a["start"]

    for q in quran:
        if q["surah"] is None:
            issues.append(
                _i(
                    "quran_unknown_surah",
                    q,
                    "اسم السورة غير معروف.",
                    "Unknown surah name.",
                    severity="info",
                )
            )
        elif not q["valid_range"]:
            issues.append(
                _i(
                    "quran_ayah_out_of_range",
                    q,
                    f"سورة {q['surah_name']} فيها {q['ayah_count']} آية فقط.",
                    f"Surah has only {q['ayah_count']} verses.",
                    ayah_count=q["ayah_count"],
                )
            )

    issues.sort(key=lambda i: i["start"])
    return {"laws": laws, "cases": appeals, "articles": articles, "quran": quran, "issues": issues,
            "suggestions": suggestions, "count": len(issues), "index_loaded": bool(index),
            "disclaimer_ar": "الأداة تتحقق من الصياغة والاتساق فقط، لا من صحة المادة أو سريانها.",
            "year_now": now}  # fmt: skip


def _i(
    kind: str, item: dict[str, Any], ar: str, en: str, severity: str = "warning", **extra: Any
) -> dict:
    return {"type": kind, "severity": severity, "start": item["start"], "end": item["end"],
            "text": item.get("text", ""), "message_ar": ar, "message_en": en, **extra}  # fmt: skip


def _article_headings(text: str) -> set[int]:
    out: set[int] = set()
    for line in text.split("\n"):
        m = _ARTICLE.match(line.strip(" \t-•*#"))
        if m:
            a = _article(m, line.strip(" \t-•*#"), [])
            if a and a["number"] is not None:
                out.add(a["number"])
    return out


def _article(m: re.Match[str], text: str, laws: list[dict[str, Any]]) -> dict[str, Any] | None:
    digits = m.group("paren") or m.group("digits")
    ord_s = m.group("ord")
    number: int | None = None
    ord_n: int | None = None
    mismatch = False
    span_end = m.end()
    if digits:
        number = to_int(digits)
        span_end = m.end("paren") + 1 if m.group("paren") else m.end("digits")
        if m.group("paren"):
            span_end = text.index(")", m.end("paren")) + 1
        # trailing ordinal word / parenthesised digits after the number -> compare
        rest = text[span_end:]
        wm = re.match(rf"\s*\(?\s*({_W})\s*\)?", rest)
        if wm and parse_ordinal(wm.group(1)) is not None and not _BIS_WORDS.fullmatch(wm.group(1)):
            ord_n = parse_ordinal(wm.group(1))
            mismatch = ord_n != number
            span_end += wm.end()
    elif ord_s:
        # words: take the longest prefix that parses as an ordinal
        toks = list(re.finditer(_W, ord_s))
        best = None
        for k in range(len(toks), 0, -1):
            cand = ord_s[: toks[k - 1].end()]
            v = parse_ordinal(cand)
            if v is not None:
                best = (v, m.start("ord") + toks[k - 1].end())
                break
        if best is None:
            return None
        ord_n, span_end = best
        number = ord_n
        rest = text[span_end:]
        dm = re.match(rf"\s*\(\s*([{_D}]+)\s*\)", rest)
        if dm:
            digits = dm.group(1)
            mismatch = to_int(digits) != ord_n
            span_end += dm.end()
    else:
        return None
    bis = sub = None
    bm = _BIS_RE.match(text[span_end:])
    if bm:
        bis = bm.group(1)
        sub = bm.group(2)
        span_end += bm.end()
    after = text[span_end:]
    external = bool(_OF_LAW.match(after)) or bool(
        re.match(r"^\s*(?:من|في)\s+(?:ال)?(?:قانون|نظام|لائحة|مرسوم|دستور|اتفاقية)", after)
    )
    internal_ok = bool(_INTERNAL.match(after)) or (not external)
    law = None
    if external:
        for lw in laws:
            if span_end <= lw["start"] <= span_end + 12:
                law = lw
                break
    line_start = text.rfind("\n", 0, m.start()) + 1
    is_heading = (
        not external
        and not text[line_start : m.start()].strip(" \t-•*#")
        and bool(re.match(r"^\s*[:\-–.]?\s*(?:\n|$|[^\sء-ي])", after) or not after.strip())
    )
    return {"type": "article", "number": number, "digits": to_int(digits) if digits else None,
            "ordinal": ord_n, "mismatch": mismatch, "bis": bis, "sub": sub, "external": external, "noun": m.group("noun"),
            "internal_ok": internal_ok, "is_heading": is_heading, "law": law, "start": m.start(),
            "end": span_end, "text": text[m.start() : span_end]}  # fmt: skip


def _quran(text: str) -> list[dict[str, Any]]:
    out = []
    for m in _QURAN.finditer(text):
        name = m.group("s1") or m.group("s2") or m.group("s3")
        a = m.group("a1") or m.group("a2") or m.group("a3")
        a_end = m.group("a1e")
        key = fold(name).removeprefix("ال").strip()
        sn = _SURAH_KEY.get(key) or _SURAH_KEY.get(fold(name))
        ayah = to_int(a)
        ayah_end = to_int(a_end) if a_end else None
        count = SURAHS[sn - 1][1] if sn else None
        out.append({
            "type": "quran", "surah": sn, "surah_name": SURAHS[sn - 1][0] if sn else name.strip(),
            "ayah": ayah, "ayah_end": ayah_end, "ayah_count": count,
            "valid_range": bool(sn) and 1 <= ayah <= count and (ayah_end is None or ayah <= ayah_end <= count),
            "canonical": f"[{SURAHS[sn - 1][0]}: {ayah}{'-' + str(ayah_end) if ayah_end else ''}]" if sn else None,
            "start": m.start(), "end": m.end(), "text": m.group(0),
        })  # fmt: skip
    return out


__all__ = ["SURAHS", "analyze_citations", "validate_index", "ordinal", "IndexError_"]
