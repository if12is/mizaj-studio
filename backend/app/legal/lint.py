"""Ambiguity & drafting linter (Task 7.10.6) and official-format checklists (Task 7.10.12).

Every rule is declared, can be switched off, and only ever produces a *warning* with a
position - nothing is rewritten. The rules are heuristics ("checklists, not a verdict"), so
expect false positives; each issue carries the rule id so the UI can mute a rule.

Issue shape: {rule, severity: info|warning, start, end, text, message_ar, message_en, ...}.
"""

from __future__ import annotations

import re
from bisect import bisect_left
from typing import Any

from app.engine.normalize import strip_marks
from app.legal.amounts import check_amounts
from app.legal.defined_terms import GENERIC_ROLES, _folded_with_map, canon_term, fold
from app.legal.tafqeet import is_number_token

_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")
_AR = "ء-ي"

RULES: dict[str, dict[str, str]] = {
    "and_or": {"severity": "warning", "title_ar": "«و/أو» غامضة", "title_en": "'and/or'"},
    "modal_mixed": {"severity": "info", "title_ar": "التزام وإذن في جملة واحدة",
                    "title_en": "Obligation and permission mixed"},
    "modal_negated_must": {"severity": "warning", "title_ar": "«لا يجب» تحتمل معنيين",
                           "title_en": "'لا يجب' is ambiguous (not required / forbidden)"},
    "vague_term": {"severity": "warning", "title_ar": "عبارة غير قابلة للقياس",
                   "title_en": "Unmeasurable wording"},
    "passive_no_agent": {"severity": "warning", "title_ar": "مبني للمجهول بلا فاعل",
                         "title_en": "Passive without an agent"},
    "double_negative": {"severity": "info", "title_ar": "نفي متعدد", "title_en": "Multiple negations"},
    "pronoun_reference": {"severity": "info", "title_ar": "ضمير قد يعود على أكثر من طرف",
                          "title_en": "Possibly ambiguous pronoun"},
    "long_sentence": {"severity": "info", "title_ar": "جملة طويلة", "title_en": "Sentence over 60 words"},
    "amount_figures_only": {"severity": "warning", "title_ar": "مبلغ بالأرقام دون حروف",
                            "title_en": "Amount without words"},
    "amount_mismatch": {"severity": "warning", "title_ar": "تعارض المبلغ بالأرقام والحروف",
                        "title_en": "Figures/words mismatch"},
    "date_no_calendar": {"severity": "info", "title_ar": "تاريخ بلا تقويم", "title_en": "Date without calendar"},
    "missing_appendix": {"severity": "warning", "title_ar": "إحالة إلى ملحق غير موجود",
                         "title_en": "Reference to a missing appendix"},
    "duration_units": {"severity": "info", "title_ar": "مدتان بوحدتين مختلفتين",
                       "title_en": "Same period in two units"},
}  # fmt: skip

MAX_WORDS = 60

VAGUE = [
    "في أقرب وقت", "في اقرب وقت ممكن", "بأقرب وقت", "بأسرع وقت", "في أسرع وقت", "خلال مدة معقولة",
    "خلال فترة معقولة", "مدة معقولة", "فترة معقولة", "في وقت مناسب", "في الوقت المناسب",
    "حسب الأحوال", "حسبما تقتضي الظروف", "حسبما يراه مناسبا", "حسب ما يراه مناسبا",
    "بالشكل المناسب", "بشكل مناسب", "بصورة مناسبة", "بالقدر الكافي", "قدر الإمكان", "عند الاقتضاء",
    "عند اللزوم", "إن لزم الأمر", "وما شابه ذلك", "ونحو ذلك", "وغير ذلك", "وغيرها", "وما إلى ذلك",
    "بما يراه مناسبا", "في حدود المعقول", "دون تأخير غير مبرر", "بعناية معقولة",
]  # fmt: skip

OBLIGATION = ["يلتزم", "تلتزم", "يلتزمان", "يلتزمون", "يجب", "يجب علي", "عليه ان", "عليها ان",
              "يتعين", "ملزم", "ملتزم", "يتوجب", "يتحتم"]  # fmt: skip
PERMISSION = ["يجوز", "للطرف", "له ان", "لها ان", "يحق", "من حق", "يمكن", "يسمح", "مخول"]
PROHIBITION = ["لا يجوز", "يحظر", "يمنع", "لا يحق", "يمتنع", "يحرم", "ممنوع", "محظور"]

_PASSIVE_AGENT = re.compile(
    r"(?:من\s+قبل|على\s+يد|بواسطة|من\s+جانب|على\s+نفقة|على\s+عاتق|يلتزم|تلتزم|"
    r"الطرف|المؤجر|المستأجر|البائع|المشتري|الموكل|الوكيل|المقاول|رب\s+العمل|صاحب\s+العمل|"
    r"العامل|المورد|العميل|الكفيل|المدين|الدائن|الشركة|المؤسسة)"
)
_PASSIVE_MARKED = re.compile(r"(?<![ء-ي])[يت]ُ[ء-يً-ْ]*[َُ]?(?![ء-ي])")
_PASSIVE_PLAIN = {"يتم", "سيتم", "تم", "يتمّ"}
_NEG = {"لا", "لم", "لن", "ليس", "ليست", "عدم", "دون", "بدون", "غير"}
_PRONOUN = re.compile(
    r"(?<![ء-ي])(?:و|ف)?(?:إليه|اليه|إليها|اليها|عليه|عليها|لديه|لديها|منه|منها|عنه|عنها|به|بها|"
    r"له|لها|فيه|فيها|هو|هي)(?![ء-ي])"
)
_MONEY_WORDS = (
    r"(?:جنيه[ًاً]?|جنيها|جنيهات|ريال[ًاً]?|ريالا|ريالات|درهم[ًاً]?|دراهم|دولار[ًاً]?|دولارا|"
    r"دينار[ًاً]?|دنانير|يورو|ج\.م|ر\.س|د\.إ|EGP|SAR|AED|USD|EUR)"
)
_NUM = r"\d[\d,٬٫.]*"
_MONEY_AFTER = re.compile(rf"(?<![\w/\-])({_NUM})\s*({_MONEY_WORDS})(?![ء-ي])")
_MONEY_BEFORE = re.compile(rf"(?<![ء-ي])({_MONEY_WORDS})\s*({_NUM})(?![\d])")
_TIME_UNIT = re.compile(r"يوم|أيام|ايام|شهر|أشهر|اشهر|سنة|سنوات|أسبوع|اسبوع|عام")
_DATE_NUM = re.compile(r"(?<![\d/])(\d{1,4})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,4})(?![\d/])")
_CAL_AFTER = re.compile(r"^\s*(?:هـ|ه|م|هجري|ميلادي|الهجري|الميلادي|للهجرة|للميلاد|هجرية|ميلادية)")
_UNITS = {"يوم": 1, "يوما": 1, "ايام": 1, "اسبوع": 7, "اسبوعا": 7, "اسابيع": 7, "شهر": 30,
          "شهرا": 30, "اشهر": 30, "شهور": 30, "سنه": 365, "سنوات": 365, "عام": 365, "اعوام": 365,
          "سنين": 365}  # fmt: skip
_UNIT_KIND = {"يوم": "d", "يوما": "d", "ايام": "d", "اسبوع": "w", "اسبوعا": "w", "اسابيع": "w",
              "شهر": "m", "شهرا": "m", "اشهر": "m", "شهور": "m", "سنه": "y", "سنوات": "y",
              "عام": "y", "اعوام": "y", "سنين": "y"}  # fmt: skip
_DURATION = re.compile(
    r"(?<![ء-ي\d])(\d+)\s*(?:\([^)]{0,40}\)\s*)?(" + "|".join(sorted(
        (k for k in ("يوما", "يوم", "أيام", "اسبوعا", "أسبوع", "أسابيع", "شهرا", "شهر", "أشهر",
                     "شهور", "سنة", "سنوات", "عاما", "عام", "أعوام", "سنين")), key=len, reverse=True))
    + r")(?![ء-ي])"
)  # fmt: skip
_SINGLE_DURATION = re.compile(
    r"(?<![ء-ي])(?:ال)?(يوم|شهر|اسبوع|أسبوع|سنة|عام)(?:ا|اً)?\s+(?:واحد[ًا]?|كامل)"
)


def _issue(rule: str, start: int, end: int, text: str, ar: str, en: str, **extra: Any) -> dict:
    return {"rule": rule, "severity": RULES[rule]["severity"], "start": start, "end": end,
            "text": text[start:end], "message_ar": ar, "message_en": en, **extra}  # fmt: skip


def _sentences(text: str) -> list[tuple[int, int]]:
    out, pos = [], 0
    for m in re.finditer(r"[.!؟?\n]+", text):
        if text[pos : m.start()].strip():
            out.append((pos, m.start()))
        pos = m.end()
    if text[pos:].strip():
        out.append((pos, len(text)))
    return out


def _has(folded: str, phrases: list[str]) -> list[str]:
    hits = []
    for p in phrases:
        if re.search(
            r"(?<![ء-ي])(?:و|ف)?" + r"\s+".join(map(re.escape, fold(p).split())) + r"(?![ء-ي])",
            folded,
        ):
            hits.append(p)
    return hits


def modality(sentence: str) -> dict[str, list[str]]:
    """Which of obligation / permission / prohibition cues occur in a sentence."""
    f = fold(sentence)
    prohib = _has(f, PROHIBITION)
    f_no_prohib = f
    for p in prohib:
        f_no_prohib = f_no_prohib.replace(fold(p), " ")
    return {"obligation": _has(f_no_prohib, OBLIGATION), "permission": _has(f_no_prohib, PERMISSION),
            "prohibition": prohib}  # fmt: skip


def _phrase_regex(phrase: str) -> re.Pattern[str]:
    return re.compile(
        r"(?<![ء-ي])(?:و|ف)?" + r"\s+".join(map(re.escape, fold(phrase).split())) + r"(?![ء-ي])"
    )


def _words(s: str) -> int:
    return len(re.findall(r"[ء-يa-zA-Z0-9٠-٩]+", s))


def lint(text: str, rules: list[str] | None = None, disabled: list[str] | None = None) -> dict:
    active = set(rules) if rules else set(RULES)
    active -= set(disabled or [])
    active &= set(RULES)
    issues: list[dict[str, Any]] = []
    folded, fmap = _folded_with_map(text)
    sents = _sentences(text)

    def span(fs: int, fe: int) -> tuple[int, int]:
        return fmap[fs], fmap[min(fe, len(fmap)) - 1] + 1

    if "and_or" in active:
        for m in re.finditer(r"و\s*/\s*أو|و\s*/\s*او|و\s+أو\s+", text):
            if m.group(0).startswith("و ") and not re.search(r"/", m.group(0)):
                continue
            issues.append(
                _issue(
                    "and_or",
                    m.start(),
                    m.end(),
                    text,
                    "«و/أو» تحتمل الجمع والتخيير معاً؛ حدّد المقصود.",
                    "'and/or' allows both readings; say which is meant.",
                )
            )

    if "vague_term" in active:
        seen: set[int] = set()
        for ph in sorted(VAGUE, key=len, reverse=True):
            for m in _phrase_regex(ph).finditer(folded):
                s, e = span(m.start(), m.end())
                if any(s < b and a < e for a, b in [(x, x + 1) for x in seen]):
                    continue
                seen.update(range(s, e))
                issues.append(
                    _issue(
                        "vague_term",
                        s,
                        e,
                        text,
                        "عبارة غير قابلة للقياس؛ الأفضل تحديد مدة أو معيار.",
                        "Not measurable; prefer a concrete period or criterion.",
                        phrase=ph,
                    )
                )

    for s0, e0 in sents:
        sent = text[s0:e0]
        lo, hi = bisect_left(fmap, s0), bisect_left(fmap, e0)
        sf = folded[lo:hi]  # folded sentence; folded index i -> span(lo + i)
        if "modal_mixed" in active or "modal_negated_must" in active:
            mod = modality(sent)
            kinds = [k for k, v in mod.items() if v]
            if "modal_mixed" in active and len(kinds) > 1:
                issues.append(
                    _issue(
                        "modal_mixed",
                        s0,
                        e0,
                        text,
                        "الجملة تجمع بين أكثر من نوع (التزام/إذن/حظر)؛ تأكد من الوضوح.",
                        "Sentence mixes obligation, permission and/or prohibition.",
                        modalities=kinds,
                    )
                )
            if "modal_negated_must" in active:
                for m in re.finditer(r"(?<![ء-ي])(?:و|ف)?لا\s+(?:ي|ت)جب(?![ء-ي])", sf):
                    s, e = span(lo + m.start(), lo + m.end())
                    issues.append(
                        _issue(
                            "modal_negated_must",
                            s,
                            e,
                            text,
                            "«لا يجب» قد تعني «ليس واجباً» أو «يُحظر»؛ استعمل «لا يجوز» أو «ليس ملزماً».",
                            "'لا يجب' may mean 'not required' or 'forbidden'; use 'لا يجوز' or 'غير ملزم'.",
                        )
                    )
        if "long_sentence" in active and _words(sent) > MAX_WORDS:
            issues.append(
                _issue(
                    "long_sentence",
                    s0,
                    e0,
                    text,
                    f"الجملة {_words(sent)} كلمة؛ يفضل تقسيمها.",
                    f"Sentence has {_words(sent)} words; consider splitting.",
                    words=_words(sent),
                )
            )
        if "passive_no_agent" in active and not _PASSIVE_AGENT.search(sf):
            for m in re.finditer(r"[ء-يً-ْ]+", sent):
                w = m.group(0)
                if (_PASSIVE_MARKED.fullmatch(w) and strip_marks(w)[:1] in "يت") or (
                    strip_marks(w) in _PASSIVE_PLAIN
                ):
                    issues.append(
                        _issue(
                            "passive_no_agent",
                            s0 + m.start(),
                            s0 + m.end(),
                            text,
                            "فعل مبني للمجهول دون بيان من يقوم به؛ حدّد الفاعل في بنود الالتزام.",
                            "Passive verb without a stated agent; name who must act.",
                            verb=w,
                        )
                    )
                    break
        if "double_negative" in active:
            toks = re.findall(r"[ء-ي]+", sf)
            negs = [
                t for i, t in enumerate(toks)
                if t in _NEG and not (t == "لا" and i + 1 < len(toks) and toks[i + 1] == "غير")
                and not (i and toks[i - 1] == "فقط" and t == "لا")
            ]  # fmt: skip
            if len(negs) >= 2:
                issues.append(
                    _issue(
                        "double_negative",
                        s0,
                        e0,
                        text,
                        "الجملة تحوي أكثر من أداة نفي؛ قد يصعب فهم المراد (يفضل الصياغة المثبتة).",
                        "Several negations in one sentence; prefer a positive wording.",
                        negations=negs,
                    )
                )
        if "pronoun_reference" in active:
            roles = _roles_in(sf)
            if len(roles) >= 2:
                last_role_end = max(r[1] for r in roles)
                for m in _PRONOUN.finditer(sf):
                    if m.start() >= last_role_end:
                        s, e = span(lo + m.start(), lo + m.end())
                        issues.append(
                            _issue(
                                "pronoun_reference",
                                s,
                                e,
                                text,
                                "الضمير قد يعود على أكثر من طرف في الجملة؛ كرّر الاسم.",
                                "Pronoun could refer to more than one party; repeat the name.",
                            )
                        )
                        break
        if "duration_units" in active:
            ds = _durations(sent)
            for i in range(len(ds)):
                for j in range(i + 1, len(ds)):
                    a, b = ds[i], ds[j]
                    if a["kind"] != b["kind"] and abs(a["days"] - b["days"]) <= max(
                        3, a["days"] // 10
                    ):
                        issues.append(
                            _issue(
                                "duration_units",
                                s0 + a["start"],
                                s0 + b["end"],
                                text,
                                "المدة نفسها مذكورة بوحدتين (يوم/شهر…) وقد لا تتطابقان.",
                                "The same period is given in two units that may not coincide.",
                            )
                        )

    if "amount_mismatch" in active:
        for it in check_amounts(text):
            if it["kind"] == "mismatch" and not _TIME_UNIT.search(it["text"]):
                issues.append(
                    _issue(
                        "amount_mismatch",
                        it["start"],
                        it["end"],
                        text,
                        it["message_ar"],
                        it["message_en"],
                        expected_words=it.get("expected_words"),
                    )
                )
    if "amount_figures_only" in active:
        issues.extend(_figures_only(text))

    if "date_no_calendar" in active:
        for m in _DATE_NUM.finditer(text.translate(_DIGITS)):
            if _CAL_AFTER.match(text[m.end() : m.end() + 20]):
                continue
            nums = [int(m.group(i)) for i in (1, 2, 3)]
            year = max(nums[0], nums[2])
            hint = (
                "hijri" if 1300 <= year <= 1500 else "gregorian" if 1800 <= year <= 2200 else None
            )
            if hint is None and not any(n > 31 for n in (nums[0], nums[2])):
                continue  # looks like a ratio / clause number, not a date
            issues.append(
                _issue(
                    "date_no_calendar",
                    m.start(),
                    m.end(),
                    text,
                    "تاريخ رقمي بلا ذكر التقويم (هـ / م)."
                    + (" السنة تبدو هجرية." if hint == "hijri" else ""),
                    "Numeric date with no calendar marker (AH/CE).",
                    likely=hint,
                )
            )

    if "missing_appendix" in active:
        issues.extend(_appendix(text))

    issues.sort(key=lambda i: (i["start"], i["rule"]))
    by_rule: dict[str, int] = {}
    for i in issues:
        by_rule[i["rule"]] = by_rule.get(i["rule"], 0) + 1
    return {"issues": issues, "count": len(issues), "by_rule": by_rule,
            "modalities": _clause_modalities(text, sents),
            "disclaimer_ar": "قوائم تحقق مساعدة لا حكم قانوني؛ قد تظهر إيجابيات كاذبة."}  # fmt: skip


def _clause_modalities(text: str, sents: list[tuple[int, int]]) -> list[dict[str, Any]]:
    out = []
    for s, e in sents:
        mod = modality(text[s:e])
        kinds = [k for k, v in mod.items() if v]
        if kinds:
            out.append({"start": s, "end": e, "kinds": kinds})
    return out


def _roles_in(folded_sentence: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    seen: set[str] = set()
    for r in GENERIC_ROLES:
        key = canon_term(r)
        if key in seen:
            continue
        m = re.search(
            r"(?<![ء-ي])(?:و|ف|ب|ل)?(?:ال)?"
            + r"\s+".join(map(re.escape, fold(r).removeprefix("ال").split()))
            + r"(?![ء-ي])",
            folded_sentence,
        )
        if m:
            seen.add(key)
            spans.append((m.start(), m.end()))
    return spans


def _durations(sent: str) -> list[dict[str, Any]]:
    out = []
    for m in _DURATION.finditer(sent.translate(_DIGITS)):
        unit = fold(m.group(2))
        if unit in _UNITS:
            out.append(
                {
                    "start": m.start(),
                    "end": m.end(),
                    "kind": _UNIT_KIND[unit],
                    "days": int(m.group(1)) * _UNITS[unit],
                }
            )
    for m in _SINGLE_DURATION.finditer(sent):
        unit = fold(m.group(1))
        unit = {"سنه": "سنه"}.get(unit, unit)
        if unit in _UNITS:
            out.append(
                {"start": m.start(), "end": m.end(), "kind": _UNIT_KIND[unit], "days": _UNITS[unit]}
            )
    return sorted(out, key=lambda d: d["start"])


def _figures_only(text: str) -> list[dict[str, Any]]:
    out = []
    norm = text.translate(_DIGITS)
    for rx in (_MONEY_AFTER, _MONEY_BEFORE):
        for m in rx.finditer(norm):
            after = text[m.end() : m.end() + 120]
            before = text[max(0, m.start() - 80) : m.start()]
            paren_words = re.match(rf"\s*\(\s*[{_AR}ً-ْ\s]{{3,}}", after)
            has_before = any(is_number_token(t) for t in re.findall(r"[ء-يً-ْ]+", before)[-4:])
            if paren_words or has_before:
                continue
            if any(i["start"] <= m.start() < i["end"] for i in out):
                continue
            out.append(
                _issue(
                    "amount_figures_only",
                    m.start(),
                    m.end(),
                    text,
                    "المبلغ مكتوب بالأرقام فقط؛ أضف التفقيط بالحروف لمنع التلاعب والالتباس.",
                    "Amount given in figures only; add the amount in words.",
                )
            )
    return out


def _appendix(text: str) -> list[dict[str, Any]]:
    headings = 0
    refs = []
    pos = 0
    for line in text.split("\n"):
        stripped = line.strip(" \t-•*#:")
        f = fold(stripped)
        if re.match(r"^(?:ال)?(?:ملحق|مرفق)(?![ء-ي])", f) and _words(stripped) <= 8:
            headings += 1
        else:
            for m in re.finditer(r"(?<![ء-ي])(?:ال)?(?:ملحق|ملاحق)(?![ء-ي])", fold(line)):
                _, fm = _folded_with_map(line)
                refs.append((pos + fm[m.start()], pos + fm[m.end() - 1] + 1))
        pos += len(line) + 1
    if headings or not refs:
        return []
    return [
        _issue(
            "missing_appendix",
            s,
            e,
            text,
            "يُشار إلى ملحق ولا يوجد ملحق بعنوانه في النص.",
            "An appendix is referenced but none is present in the text.",
        )
        for s, e in refs
    ]


# ------------------------------------------------------------------ official formats (7.10.12)
# Cue lists are folded (no marks, hamza-insensitive). Orders and labels differ per country:
# this is a starter checklist the user is expected to adapt.
DOC_TYPES: dict[str, dict[str, Any]] = {
    "official_letter": {
        "title_ar": "خطاب رسمي",
        "sections": [
            ("addressee", "المرسل إليه وصفته (السيد/الأستاذ … المحترم)",
             ["المحترم", "المحترمه", "المحترمين", "السيد", "السيده", "السادة", "الاستاذ"]),
            ("greeting", "التحية (تحية طيبة وبعد)", ["تحيه طيبه", "السلام عليكم", "بعد التحيه"]),
            ("subject", "الموضوع", ["الموضوع"]),
            ("closing", "الخاتمة (وتفضلوا بقبول فائق الاحترام)",
             ["فائق الاحترام", "فائق التقدير", "خالص التحيه", "وتفضلوا", "وتفضلو"]),
            ("date", "التاريخ", ["التاريخ"]),
            ("signature", "التوقيع", ["التوقيع", "مقدمه لسيادتكم", "المدير", "رئيس"]),
        ],
    },
    "defense_memo": {
        "title_ar": "مذكرة دفاع",
        "sections": [
            ("court", "المحكمة والدائرة", ["محكمه", "دائره"]),
            ("case_no", "رقم القضية", ["القضيه رقم", "الدعوي رقم", "رقم الدعوي", "رقم القضيه", "الطعن رقم"]),
            ("facts", "الوقائع", ["الوقائع", "وقائع"]),
            ("defenses", "الدفوع", ["الدفوع", "الدفع"]),
            ("grounds", "الأسانيد", ["الاسانيد", "الاساس القانوني", "الاسباب"]),
            ("requests", "الطلبات", ["الطلبات", "لذلك", "بناء عليه"]),
        ],
    },
    "legal_memo": {
        "title_ar": "مذكرة قانونية",
        "sections": [
            ("facts", "الوقائع", ["الوقائع", "وقائع"]),
            ("defenses", "الدفوع أو المسائل القانونية", ["الدفوع", "المسائل القانونيه", "الاشكاليه"]),
            ("grounds", "الأسانيد", ["الاسانيد", "السند القانوني", "الاساس القانوني"]),
            ("requests", "الطلبات أو التوصية", ["الطلبات", "التوصيه", "الخلاصه"]),
        ],
    },
    "statement_of_claim": {
        "title_ar": "صحيفة دعوى",
        "sections": [
            ("court", "المحكمة المختصة", ["محكمه", "دائره"]),
            ("plaintiff", "المدعي وصفته وموطنه", ["المدعي", "المدعيه"]),
            ("defendant", "المدعى عليه وصفته وموطنه", ["المدعي عليه", "المدعي عليها", "المدعى عليه"]),
            ("domicile", "الموطن", ["موطن", "مقيم", "عنوان"]),
            ("facts", "الوقائع", ["الوقائع", "وقائع"]),
            ("grounds", "الأسانيد", ["الاسانيد", "السند", "الاساس القانوني"]),
            ("requests", "الطلبات الختامية", ["الطلبات", "لذلك", "اطلب", "يلتمس", "تلتمس"]),
        ],
    },
    "notice": {
        "title_ar": "إنذار على يد محضر",
        "sections": [
            ("bailiff", "المحضر", ["محضر", "اعلان", "اعلنت"]),
            ("sender", "المنذِر", ["المنذر", "طالب الاعلان"]),
            ("addressee", "المنذَر إليه", ["المنذر اليه", "المعلن اليه", "المنذر ضده"]),
            ("facts", "الوقائع", ["الوقائع", "وقائع", "حيث ان"]),
            ("demand", "المطلوب", ["انذر", "ينذر", "المطلوب", "اطالب", "يطالب"]),
            ("deadline", "المهلة", ["مهله", "خلال", "ميعاد"]),
            ("reservation", "حفظ الحقوق", ["حفظ حق", "مع حفظ", "جميع الحقوق"]),
        ],
    },
    "power_of_attorney": {
        "title_ar": "توكيل",
        "sections": [
            ("principal", "الموكِّل", ["الموكل", "اوكل", "وكلت"]),
            ("agent", "الوكيل", ["الوكيل", "وكيلا"]),
            ("scope", "حدود الوكالة", ["في ان", "بالتوقيع", "وكاله خاصه", "وكاله عامه", "صلاحيه"]),
            ("term", "المدة أو سريان الوكالة", ["مده", "سارية", "ساريه", "حتي", "ما لم تلغ"]),
            ("signature", "التوقيع والتصديق", ["توقيع", "التوقيع", "امام", "موثق"]),
        ],
    },
    "minutes": {
        "title_ar": "محضر اجتماع",
        "sections": [
            ("date", "التاريخ والمكان", ["بتاريخ", "التاريخ", "مكان"]),
            ("attendees", "الحضور", ["الحضور", "حضر"]),
            ("agenda", "جدول الأعمال", ["جدول الاعمال", "جدول اعمال", "الاجندة"]),
            ("decisions", "القرارات والتوصيات", ["القرارات", "التوصيات", "تقرر", "قرر"]),
            ("signature", "التوقيعات", ["التوقيعات", "توقيع"]),
        ],
    },
    "complaint": {
        "title_ar": "شكوى",
        "sections": [
            ("addressee", "الجهة المشتكى إليها", ["المحترم", "السيد", "السادة"]),
            ("complainant", "مقدم الشكوى", ["مقدم الشكوي", "اتقدم", "اني", "انا"]),
            ("facts", "وقائع الشكوى", ["الوقائع", "وقائع", "حيث ان"]),
            ("requests", "الطلب", ["اطلب", "التمس", "الطلب", "ارجو"]),
            ("closing", "الخاتمة", ["الاحترام", "التقدير", "وتفضلوا"]),
        ],
    },
}  # fmt: skip


def check_structure(text: str, doc_type: str) -> dict[str, Any]:
    """Checklist of the expected parts for a document type (suggestions only)."""
    spec = DOC_TYPES.get(doc_type)
    if spec is None:
        raise KeyError(doc_type)
    f = fold(text)
    found, missing = [], []
    for sid, label, cues in spec["sections"]:
        hit = next(
            (
                c
                for c in cues
                if re.search(r"(?<![ء-ي])" + r"\s+".join(map(re.escape, fold(c).split())), f)
            ),
            None,
        )
        (found if hit else missing).append(
            {"id": sid, "label_ar": label, **({"cue": hit} if hit else {})}
        )
    return {"doc_type": doc_type, "title_ar": spec["title_ar"], "found": found, "missing": missing,
            "note_ar": "التسميات والترتيب تختلف باختلاف الدولة والجهة؛ هذه قائمة تحقق عامة."}  # fmt: skip
