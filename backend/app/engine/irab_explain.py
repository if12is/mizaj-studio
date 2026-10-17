"""Per-word i'rab explainer (Task 7.5.1): case, sign and a short reason from fixed templates.

Built on the qalsadi analysis of the word and on the vocalization an engine chose in context.
It is a teaching aid, NOT a full grammatical parse: the role is only named when a simple local
pattern supports it, and "غير متأكد" is returned when nothing does.
"""

from __future__ import annotations

from typing import Any

from app.engine.normalize import last_letter_split, split_pairs, strip_marks

D, F, K, S = "ُ", "َ", "ِ", "ْ"
DT, FT, KT = "ٌ", "ً", "ٍ"
CASE_BY_MARK = {D: "مرفوع", DT: "مرفوع", F: "منصوب", FT: "منصوب", K: "مجرور", KT: "مجرور"}
SIGN_BY_MARK = {D: "الضمة", DT: "تنوين الضم", F: "الفتحة", FT: "تنوين الفتح", K: "الكسرة",
                KT: "تنوين الكسر", S: "السكون"}  # fmt: skip
PREPOSITIONS = {"من", "إلى", "عن", "على", "في", "حتى", "منذ", "مذ", "رب", "ب", "ل", "ك"}
INNA = {"إن", "أن", "لكن", "ليت", "لعل", "كأن"}
KANA = {"كان", "كانت", "يكون", "تكون", "أصبح", "أصبحت", "أمسى", "بات", "ظل", "ظلت", "صار", "صارت",
        "ليس", "ليست"}  # fmt: skip
DISCLAIMER = "شرح تعليمي آلي مبني على التحليل الصرفي والسياق القريب؛ وليس إعراباً نحوياً كاملاً."


def _kind(a: dict[str, Any]) -> str:
    t = a["type"]
    if t.startswith("Verb"):
        return "فعل"
    if t.startswith("STOPWORD"):
        return "حرف/أداة"
    return "اسم"


def _case_and_sign(bare: str, voc: str, kind: str, tags: str) -> tuple[str | None, str | None]:
    internal, ending = last_letter_split(voc)
    mark = next((c for c in ending if c in CASE_BY_MARK or c == S), None)
    if kind == "اسم":
        if mark in CASE_BY_MARK:
            return CASE_BY_MARK[mark], SIGN_BY_MARK[mark]
        return None, None
    if kind == "فعل":
        if "الماضي" in tags:
            return "مبني", "الفتح" if mark == F else (SIGN_BY_MARK.get(mark) or "البناء")
        if "الأمر" in tags:
            return "مبني", "السكون" if mark == S else "البناء"
        if mark == D:
            return "مرفوع", "الضمة"
        if mark == F:
            return "منصوب", "الفتحة"
        if mark == S:
            return "مجزوم", "السكون"
    return None, None


def explain(
    word: str,
    chosen: str | None,
    prev_words: list[str],
    analyses: list[dict[str, Any]],
    prev_analyses: list[list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    """`chosen` = the engine's vocalization of the word in context (or None). `prev_words` = the
    bare words before it (nearest last)."""
    bare = strip_marks(word)
    base: dict[str, Any] = {"word": word, "bare": bare, "disclaimer": DISCLAIMER}
    if not analyses:
        return {
            **base,
            "certainty": "unknown",
            "case": None,
            "sign": None,
            "role": None,
            "reason": "غير متأكد: لا يوجد تحليل صرفي لهذه الكلمة.",
            "candidates": [],
        }
    pick = None
    if chosen:
        want = split_pairs(chosen)
        for a in analyses:
            if split_pairs(a["vocalized"]) == want:
                pick = a
                break
        if pick is None:  # same internal vowels, different case ending
            ci = last_letter_split(chosen)[0]
            pick = next((a for a in analyses if last_letter_split(a["vocalized"])[0] == ci), None)
    exact = (
        pick is not None
        and chosen is not None
        and split_pairs(pick["vocalized"]) == split_pairs(chosen)
    )
    if pick is None:
        pick = max(analyses, key=lambda a: a["freq"])
        chosen = None
    kind = _kind(pick)
    voc = chosen or pick["vocalized"]
    case, sign = _case_and_sign(bare, voc, kind, pick["tags"])
    role, reason, certainty = None, "غير متأكد من وظيفة الكلمة في الجملة.", "low"
    prev = prev_words[-1] if prev_words else ""
    prev2 = prev_words[-2] if len(prev_words) > 1 else ""
    pk = _kind(prev_analyses[-1][0]) if prev_analyses and prev_analyses[-1] else None
    if case and kind == "اسم":
        if prev in PREPOSITIONS and case == "مجرور":
            role, certainty = "اسم مجرور", "medium"
            reason = f"اسم مجرور بحرف الجر «{prev}» وعلامة جره {sign}."
        elif prev in INNA and case == "منصوب":
            role, certainty = "اسم إنّ", "medium"
            reason = f"اسم «{prev}» منصوب وعلامة نصبه {sign}."
        elif prev in KANA and case == "مرفوع":
            role, certainty = "اسم كان", "medium"
            reason = f"اسم «{prev}» مرفوع وعلامة رفعه {sign}."
        elif prev2 in KANA and case == "منصوب":
            role, certainty = "خبر كان", "medium"
            reason = f"خبر «{prev2}» منصوب وعلامة نصبه {sign}."
        elif pk == "فعل" and case == "مرفوع":
            role = "فاعل (محتمل)"
            reason = f"يُرجَّح أنه فاعل للفعل «{prev}» مرفوع وعلامة رفعه {sign}."
        elif pk == "فعل" and case == "منصوب":
            role = "مفعول به (محتمل)"
            reason = f"يُرجَّح أنه مفعول به للفعل «{prev}» منصوب وعلامة نصبه {sign}."
        elif pk == "اسم" and case == "مجرور":
            role = "مضاف إليه (محتمل)"
            reason = f"يُرجَّح أنه مضاف إليه مجرور وعلامة جره {sign}."
        elif not prev_words and case == "مرفوع":
            role = "مبتدأ (محتمل)"
            reason = f"يُرجَّح أنه مبتدأ مرفوع وعلامة رفعه {sign}."
        else:
            reason = f"{case} وعلامته {sign}؛ غير متأكد من وظيفته النحوية."
    elif kind == "فعل" and case:
        role, certainty = "فعل", "medium"
        reason = f"فعل {case} وعلامته {sign}." if case != "مبني" else f"فعل مبني على {sign}."
    elif kind == "حرف/أداة":
        role, certainty = "حرف أو أداة", "medium"
        reason = "حرف أو أداة؛ لا تُعرَب إعراب الأسماء."
    if not exact:
        certainty = "low"
        reason += " (التحليل مبني على أرجح احتمال لأن السياق لم يُحدِّد الصيغة)."
    cands = sorted(analyses, key=lambda a: -a["freq"])[:5]
    return {
        **base,
        "vocalized": voc,
        "type": kind,
        "case": case,
        "sign": sign,
        "role": role,
        "reason": reason,
        "certainty": certainty,
        "root": pick["root"] or None,
        "lemma": pick["lemma"] or None,
        "tags": pick["tags"],
        "candidates": [
            {"vocalized": a["vocalized"], "type": _kind(a), "tags": a["tags"]} for a in cands
        ],
    }  # fmt: skip
