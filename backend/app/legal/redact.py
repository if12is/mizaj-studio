"""Offline redaction suggestions (Task 7.10.10).

Everything runs locally and only *proposes* edits: nothing is applied here, and the original
text is never modified. Detection is pattern + checksum based (no NER), so it cannot promise
to find all personal data - the UI must make the user review every item.

Identifier rules (see `docs` notes in the module constants):
* Egyptian national ID: 14 digits = century (2 -> 1900s, 3 -> 2000s) + YYMMDD valid, past date +
  governorate code. The last digit is a check digit whose algorithm is not publicly documented,
  so only the structure is validated (confidence "high" when valid, "low" otherwise).
* Saudi ID / Iqama: 10 digits starting with 1 (citizen) / 2 (resident); Luhn-validated.
* UAE Emirates ID: 15 digits `784-YYYY-NNNNNNN-C`; last digit Luhn.
* IBAN: ISO 13616 mod-97 plus known lengths (SA 24, AE 23, EG 29, ...).
* Cards: 13-19 digits, Luhn.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import re
from typing import Any

from app.legal.defined_terms import _folded_with_map, analyze_terms, canon_term, fold

CATEGORIES = ("id", "phone", "email", "iban", "card", "passport", "name", "party")
STYLES = ("mask", "placeholder", "pseudonym")
_DIG = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")

EG_GOVERNORATES = {1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28,
                   29, 31, 32, 33, 34, 35, 88}  # fmt: skip
IBAN_LEN = {"SA": 24, "AE": 23, "EG": 29, "KW": 30, "QA": 29, "BH": 22, "OM": 23, "JO": 30,
            "LB": 28, "IQ": 23, "GB": 22, "DE": 22, "FR": 27, "ES": 24, "IT": 27, "NL": 18,
            "TR": 26, "CH": 21}  # fmt: skip

TITLES = ["السيد", "السيدة", "الأستاذ", "الأستاذة", "الاستاذ", "الاستاذة", "المدعو", "المدعوة",
          "الدكتور", "الدكتورة", "المهندس", "المهندسة", "الشيخ", "الحاج", "الحاجة", "السادة",
          "المستشار", "المستشارة", "الفاضل", "الفاضلة", "الآنسة", "الانسة"]  # fmt: skip
_TITLE_RE = "|".join(sorted(TITLES, key=len, reverse=True))
_STOP = {"وهو", "وهي", "ويقيم", "المقيم", "المقيمة", "ومقيم", "ومقيمة", "الحامل", "الحاملة", "حامل",
         "يحمل", "تحمل", "بصفته", "بصفتها", "المحترم", "المحترمة", "رقم", "المولود", "المولودة",
         "الجنسية", "في", "من", "على", "الى", "إلى", "عن", "مع", "و", "ب", "ويحمل", "وتحمل",
         "والمقيم", "والمقيمة", "القاطن", "القاطنة", "المتواجد", "الذي", "التي", "طرف", "بطاقة",
         "هوية", "الموكل", "الوكيل", "المؤجر", "المستأجر", "ويشار", "يشار", "ويُشار", "يُشار",
         "المدعي", "المدعى", "عليه", "ممثل", "ممثلا", "الممثل", "المحامي", "بموجب", "وذلك",
         "قد", "كل", "ان", "أن", "إن", "حيث", "حضر", "حضرت", "اسم", "اسمه"}  # fmt: skip
_NAME_CONNECT = {"بن", "ابن", "بنت", "ابنة", "أبو", "ابو", "أبي", "آل", "ال", "عبد"}
_TITLE_NAME = re.compile(
    rf"(?<![ء-ي])(?P<title>(?:(?:{_TITLE_RE})\s*[/:]?\s*)+)(?P<name>[ء-يً-ْ]+(?:\s+[ء-يً-ْ]+){{0,4}})"
)
_EMAIL = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![\w-])")
_IBAN = re.compile(
    r"(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?(?![A-Za-z0-9])"
)
_EID = re.compile(r"(?<!\d)784[- ]?\d{4}[- ]?\d{7}[- ]?\d(?!\d)")
_DIGITS14 = re.compile(r"(?<![\d.,])\d{14}(?![\d])")
_DIGITS10 = re.compile(r"(?<![\d.,+])[12]\d{9}(?![\d])")
_CARD = re.compile(r"(?<![\d.,])\d(?:[ -]?\d){12,18}(?![\d])")
_PHONE = re.compile(
    r"(?<![A-Za-z\d])(?:\+|00)\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}(?![\d])"
    r"|(?<![A-Za-z\d+])(?:0?1[0125]\d{8}|0?5\d{8})(?![\d])"
    r"|(?<![A-Za-z\d+])0[1-9][\s-]?\d{3,4}[\s-]?\d{4}(?![\d])"
)
_PASSPORT = re.compile(r"(?<![A-Za-z0-9])[A-Z]{1,2}\d{6,9}(?![A-Za-z0-9])")
_PASSPORT_CTX = re.compile(r"(?:جواز(?:\s+السفر)?|passport)[^\n]{0,20}$", re.I)
_PASSPORT_DIGITS = re.compile(r"جواز(?:\s+سفر)?\s+(?:رقم\s*)?(\d{6,10})(?!\d)")


def luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d *= 2
            d = d - 9 if d > 9 else d
        total += d
    return total % 10 == 0


def eg_id_ok(d: str) -> bool:
    if len(d) != 14 or d[0] not in "23":
        return False
    year = (1900 if d[0] == "2" else 2000) + int(d[1:3])
    try:
        born = _dt.date(year, int(d[3:5]), int(d[5:7]))
    except ValueError:
        return False
    return born <= _dt.date.today() and int(d[7:9]) in EG_GOVERNORATES


def iban_ok(raw: str) -> bool:
    s = raw.replace(" ", "")
    if not 15 <= len(s) <= 34 or not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]+", s):
        return False
    if IBAN_LEN.get(s[:2], len(s)) != len(s):
        return False
    rearranged = s[4:] + s[:4]
    num = "".join(str(int(c, 36)) for c in rearranged)
    return int(num) % 97 == 1


def _item(
    cat: str,
    kind: str,
    m_start: int,
    m_end: int,
    text: str,
    conf: str,
    valid: bool | None,
    note: str = "",
) -> dict[str, Any]:
    return {"category": cat, "kind": kind, "start": m_start, "end": m_end,
            "original": text[m_start:m_end], "confidence": conf, "checksum_valid": valid,
            "note": note}  # fmt: skip


def _detect_patterns(text: str) -> list[dict[str, Any]]:
    t = text.translate(_DIG)  # same length as text -> offsets are shared
    out: list[dict[str, Any]] = []
    for m in _IBAN.finditer(t):
        ok = iban_ok(m.group(0))
        if ok:
            out.append(_item("iban", "iban", m.start(), m.end(), text, "high", True))
    for m in _EID.finditer(t):
        d = re.sub(r"\D", "", m.group(0))
        ok = luhn_ok(d)
        out.append(
            _item(
                "id",
                "ae_emirates_id",
                m.start(),
                m.end(),
                text,
                "high" if ok else "low",
                ok,
                "" if ok else "رقم التحقق لا يطابق",
            )
        )
    for m in _DIGITS14.finditer(t):
        ok = eg_id_ok(m.group(0))
        out.append(
            _item(
                "id",
                "eg_national_id",
                m.start(),
                m.end(),
                text,
                "high" if ok else "low",
                None,
                "البنية صحيحة (القرن/التاريخ/المحافظة)؛ خوارزمية رقم التحقق غير منشورة"
                if ok
                else "14 رقماً لكن البنية لا تطابق الرقم القومي",
            )
        )
    for m in _EMAIL.finditer(t):
        out.append(_item("email", "email", m.start(), m.end(), text, "high", None))
    for m in _DIGITS10.finditer(t):
        ok = luhn_ok(m.group(0))
        out.append(
            _item(
                "id",
                "sa_iqama" if m.group(0)[0] == "2" else "sa_national_id",
                m.start(),
                m.end(),
                text,
                "high" if ok else "low",
                ok,
                "" if ok else "رقم التحقق لا يطابق",
            )
        )
    for m in _CARD.finditer(t):
        d = re.sub(r"\D", "", m.group(0))
        if 13 <= len(d) <= 19 and luhn_ok(d) and not re.fullmatch(r"\d{14}", d):
            out.append(_item("card", "card", m.start(), m.end(), text, "medium", True))
    for m in _PHONE.finditer(t):
        digits = re.sub(r"\D", "", m.group(0))
        if len(digits) < 8 or len(digits) > 15:
            continue
        kind = _phone_kind(m.group(0), digits)
        if kind is None:
            continue
        out.append(
            _item(
                "phone",
                kind,
                m.start(),
                m.end(),
                text,
                "high" if kind != "phone" else "medium",
                None,
            )
        )
    for m in _PASSPORT.finditer(t):
        ctx = bool(_PASSPORT_CTX.search(t[max(0, m.start() - 30) : m.start()]))
        out.append(
            _item(
                "passport", "passport", m.start(), m.end(), text, "medium" if ctx else "low", None
            )
        )
    for m in _PASSPORT_DIGITS.finditer(t):
        out.append(_item("passport", "passport", m.start(1), m.end(1), text, "medium", None))
    return out


def _phone_kind(raw: str, digits: str) -> str | None:
    d = digits.removeprefix("00") if raw.lstrip().startswith("00") else digits
    if raw.startswith("+") or raw.startswith("00"):
        if d.startswith("20") and re.fullmatch(r"20(1[0125]\d{8})", d):
            return "phone_eg"
        if d.startswith("966") and re.fullmatch(r"9665\d{8}", d):
            return "phone_sa"
        if d.startswith("971") and re.fullmatch(r"9715\d{8}", d):
            return "phone_ae"
        return "phone"
    if re.fullmatch(r"0?1[0125]\d{8}", digits):
        return "phone_eg" if len(digits) == 11 or len(digits) == 10 else None
    if re.fullmatch(r"0?5\d{8}", digits):
        return "phone_sa"  # 05xxxxxxxx is shared by SA and AE mobiles
    return "phone" if digits.startswith("0") and len(digits) in (9, 10, 11) else None


def _clean_name(raw: str) -> str | None:
    toks = raw.split()
    out: list[str] = []
    for i, tok in enumerate(toks):
        bare = re.sub(r"[ً-ْ]", "", tok)
        if bare in _STOP:
            break
        if i == 0 and bare.startswith("ال") and bare not in _NAME_CONNECT:
            return None  # "السيد المدير" - a role, not a personal name
        out.append(tok)
        if len(out) >= 4:
            break
    return " ".join(out) if out and (len(out) >= 2 or len(out[0]) >= 3) else None


def _title_names(text: str) -> list[dict[str, Any]]:
    out = []
    for m in _TITLE_NAME.finditer(text):
        name = _clean_name(m.group("name"))
        if not name:
            continue
        start = m.start("name")
        out.append(
            _item(
                "name", "person_name", start, start + len(name), text, "medium", None, "اسم بعد لقب"
            )
        )
    return out


def _find_phrase(text: str, folded: str, fmap: list[int], phrase: str) -> list[tuple[int, int]]:
    key = fold(phrase)
    if not key:
        return []
    rx = re.compile(
        r"(?<![ء-ي])(?:و|ف|ب|ل|ك)?" + r"\s+".join(map(re.escape, key.split())) + r"(?![ء-ي])"
    )
    res = []
    for m in rx.finditer(folded):
        s = m.start()
        if m.group(0) != key and m.group(0)[0] in "وفبلك" and m.group(0)[1:].startswith(key[:1]):
            s += 1  # skip the attached particle
        res.append((fmap[s], fmap[m.end() - 1] + 1))
    return res


def _party_names(text: str) -> dict[str, str]:
    """name -> role placeholder, taken from the text before each definition (7.10.4)."""
    res: dict[str, str] = {}
    for d in analyze_terms(text)["terms"]:
        ctx = d.get("definition", "")
        cands: list[tuple[int, str]] = []
        for m in _TITLE_NAME.finditer(ctx):
            name = _clean_name(m.group("name"))
            if name:
                cands.append((m.start(), name))
        for cm in re.finditer(r"(?:شركة|مؤسسة)\s+([ء-يً-ْ]+(?:\s+[ء-يً-ْ]+){0,3})", ctx):
            nm = _clean_name(cm.group(1))
            if nm:
                cands.append((cm.start(), nm))
        if cands:
            res[max(cands)[1]] = d["term"]  # the name closest to the definition
    return res


# ------------------------------------------------------------------ replacements
_PSEUDO_NAMES = ["سامي حسن", "ليلى منصور", "كريم فؤاد", "هدى رشدي", "ياسر نجيب", "منى سالم",
                 "طارق عادل", "رنا شاكر", "وليد صبري", "دينا فاضل", "عمر زكي", "سلمى حمدي"]  # fmt: skip
_LABEL = {"id": "هوية", "phone": "هاتف", "email": "بريد", "iban": "آيبان", "card": "بطاقة",
          "passport": "جواز", "name": "اسم", "party": "اسم"}  # fmt: skip


def _fake_digits(original: str, seed: str) -> str:
    h = hashlib.sha256((seed + original).encode()).hexdigest()
    digits = [str(int(c, 16) % 10) for c in h * 3]
    it = iter(digits)
    return "".join(next(it) if c.isdigit() else c for c in original.translate(_DIG))


def _mask(item: dict[str, Any]) -> str:
    o = item["original"]
    if item["category"] in ("name", "party"):
        return " ".join(w[0] + "***" for w in o.split())
    if item["category"] == "email":
        return o[0] + "***@***"
    keep = 2
    chars = list(o)
    idx = [i for i, c in enumerate(chars) if c.isalnum()]
    for i in idx[: max(0, len(idx) - keep)]:
        chars[i] = "*"
    return "".join(chars)


def redact(
    text: str,
    categories: list[str] | None = None,
    style: str = "placeholder",
    names: list[str] | None = None,
    use_parties: bool = True,
    seed: str = "",
) -> dict[str, Any]:
    cats = [c for c in (categories or CATEGORIES) if c in CATEGORIES]
    if style not in STYLES:
        raise ValueError(f"style must be one of {STYLES}")
    found: list[dict[str, Any]] = []
    for it in _detect_patterns(text):
        if it["category"] in cats:
            found.append(it)
    if "name" in cats:
        found.extend(_title_names(text))
    folded, fmap = _folded_with_map(text)
    if "name" in cats:
        for nm in names or []:
            for s, e in _find_phrase(text, folded, fmap, nm):
                found.append(
                    _item("name", "listed_name", s, e, text, "high", None, "اسم من قائمتك")
                )
    role_of: dict[str, str] = {}
    if "party" in cats and use_parties:
        role_of = _party_names(text)
        for nm, role in role_of.items():
            for s, e in _find_phrase(text, folded, fmap, nm):
                found.append(
                    {
                        **_item("party", "party_name", s, e, text, "high", None, "اسم طرف معرَّف"),
                        "role": role,
                    }
                )
    # resolve overlaps: keep the first by (priority, start); drop anything overlapping a kept item
    prio = {
        "iban": 0,
        "id": 1,
        "email": 2,
        "card": 3,
        "phone": 4,
        "passport": 5,
        "party": 6,
        "name": 7,
    }
    found.sort(key=lambda i: (prio[i["category"]], -(i["end"] - i["start"]), i["start"]))
    kept: list[dict[str, Any]] = []
    for it in found:
        if any(it["start"] < k["end"] and k["start"] < it["end"] for k in kept):
            continue
        kept.append(it)
    kept.sort(key=lambda i: i["start"])

    registry: dict[tuple[str, str], str] = {}
    counters: dict[str, int] = {}
    mapping: dict[str, dict[str, Any]] = {}
    for n, it in enumerate(kept, 1):
        key_val = (
            fold(it["original"])
            if it["category"] in ("name", "party")
            else re.sub(r"[\s-]", "", it["original"].translate(_DIG)).upper()
        )
        key = (it["category"] if it["category"] != "party" else "name", key_val)
        if key not in registry:
            cat = key[0]
            counters[cat] = counters.get(cat, 0) + 1
            k = counters[cat]
            if style == "placeholder":
                if it["category"] == "party" and it.get("role"):
                    rep = f"[{it['role']}]"
                else:
                    rep = f"[{_LABEL[cat]} {k}]"
            elif style == "mask":
                rep = _mask(it)
            else:  # pseudonym
                if cat == "name":
                    rep = _PSEUDO_NAMES[(k - 1) % len(_PSEUDO_NAMES)] + (
                        f" {k // len(_PSEUDO_NAMES) + 1}" if k > len(_PSEUDO_NAMES) else ""
                    )
                elif cat == "email":
                    rep = f"user{k}@example.com"
                else:
                    rep = _fake_digits(it["original"], seed)
            registry[key] = rep
        it["id"] = n
        it["replacement"] = registry[key]
        row = mapping.setdefault(
            registry[key],
            {
                "replacement": registry[key],
                "category": it["category"],
                "original": it["original"],
                "count": 0,
            },
        )
        row["count"] += 1
    return {"edits": kept, "mapping": list(mapping.values()), "style": style,
            "counts": {c: sum(1 for i in kept if i["category"] == c) for c in cats},
            "applied": False,
            "warning_ar": "الكشف آلي ولا يضمن العثور على كل البيانات الشخصية؛ راجع كل اقتراح ولا تعتمد عليه وحده. جدول المطابقة يبقى محلياً ويجب عدم مشاركته.",
            "warning_en": "Detection is best-effort; review every suggestion. The mapping table stays local - do not share it."}  # fmt: skip


def apply_edits(text: str, edits: list[dict[str, Any]]) -> str:
    """Apply accepted edits (non-overlapping, offsets into the original text)."""
    out, pos = [], 0
    for e in sorted(edits, key=lambda e: e["start"]):
        if e["start"] < pos:
            raise ValueError("overlapping edits")
        out.append(text[pos : e["start"]])
        out.append(e["replacement"])
        pos = e["end"]
    out.append(text[pos:])
    return "".join(out)


__all__ = [
    "CATEGORIES",
    "STYLES",
    "redact",
    "apply_edits",
    "luhn_ok",
    "eg_id_ok",
    "iban_ok",
    "canon_term",
]
