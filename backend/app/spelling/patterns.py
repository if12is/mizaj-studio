"""7.9.2 Rule-based common-error patterns.

Principles: low false-positive rate beats recall; every rule has a stable code, an Arabic
explanation, a suggestion list and a confidence; rules never modify text (suggestions only).
Where possible the dictionary decides (candidate must be a valid word, the written form must
not be a strictly-known lexicon word).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .engine import DATA_DIR, SpellEngine
from .text import Token

_CONF = json.loads((Path(DATA_DIR) / "confusables.json").read_text(encoding="utf-8"))
CONFUSABLES: dict[str, dict] = _CONF["words"]
REPEAT_FUNCTION = set(_CONF["repeat_function_words"])
REPEAT_ALLOWED = set(_CONF["repeat_allowed"])
NAME_BEFORE = set(_CONF["alla_names_before"])
ALA_VERBS = set(_CONF["ala_after_verbs"])

HAMZA_ALEF = "اأإآ"
SAYING_VERBS = {
    "قال",
    "قالت",
    "يقول",
    "ذكر",
    "ذكرت",
    "أكد",
    "أكدت",
    "يؤكد",
    "أعلن",
    "أعلنت",
    "بين",
    "يرى",
    "رأى",
    "أوضح",
    "أوضحت",
    "أفاد",
    "أشار",
    "أشارت",
    "اعتبر",
    "يعتبر",
    "علم",
    "نعلم",
    "أعلم",
    "أعتقد",
    "نعتقد",
    "أظن",
    "ظن",
    "تبين",
    "يتضح",
    "اتضح",
    "الواضح",
    "المعروف",
    "بأن",
    "لأن",
    "كون",
    "حيث",
    "ويرى",
    "وأكد",
    "وقال",
    "وذكر",
    "وأعلن",
    "وبين",
    "ونعلم",
}

SAYING_VERBS_IN = {
    "قال",
    "قالت",
    "يقول",
    "تقول",
    "قالوا",
    "وقال",
    "وقالت",
    "ويقول",
    "فقال",
    "فقالت",
}

_SENT_END = set(".!؟?\n؛:")

MSG = {
    "HAMZA_QAT": "همزة القطع: تُكتب الهمزة (أ / إ) في هذه الكلمة.",
    "HAMZA_WASL": "همزة الوصل: تُكتب ألفاً مجردة بلا همزة في هذه الكلمة.",
    "HAMZA_SEAT": "موضع الهمزة: كُتبت الهمزة على كرسي غير صحيح.",
    "TAA_MARBUTA": "التاء المربوطة: الكلمة تنتهي بتاء مربوطة (ة) لا بهاء (ه).",
    "ALEF_MAQSURA": "الألف المقصورة: تُكتب الكلمة بألف مقصورة (ى) لا بياء.",
    "ALEF_FARQA": "الألف الفارقة: تُكتب ألف بعد واو الجماعة في آخر الفعل.",
    "SPLIT_JOIN": "الفصل والوصل: رسم الكلمة غير صحيح.",
    "TANWEEN_ALEF": "لا تُزاد ألف التنوين بعد التاء المربوطة أو الهمزة المسبوقة بألف.",
    "TANWEEN_STYLE": "تنوين الفتح كُتب بأسلوبين مختلفين في المستند؛ يُنصح بتوحيده.",
    "REPEATED_WORD": "كلمة مكررة.",
    "AN_HU": "الهمزة في «إنه/أنه»: يتوقف رسمها على موقعها في الجملة.",
}


def _issue(tok_start, tok_end, text, code, sev, sugg, conf, msg=None):
    return {
        "start": tok_start,
        "end": tok_end,
        "word": text[tok_start:tok_end],
        "code": code,
        "category": "pattern",
        "severity": sev,
        "message_ar": msg or MSG[code],
        "suggestions": sugg,
        "confidence": conf,
    }


_CLITICS = {
    "",
    "ال",
    "و",
    "ف",
    "ب",
    "ل",
    "ك",
    "وال",
    "فال",
    "بال",
    "كال",
    "لل",
    "ولل",
    "وب",
    "ول",
    "فب",
    "فل",
    "س",
    "وس",
    "فس",
}


def _variants_alef(key: str):
    """Hamza/alef confusions, only where the hamza matters: the stem-initial letter."""
    for i, ch in enumerate(key[:5]):
        if ch in HAMZA_ALEF and key[:i] in _CLITICS:
            for c in "اأإ":
                if c != ch:
                    yield key[:i] + c + key[i + 1 :]


def _is_sentence_start(text: str, pos: int) -> bool:
    i = pos - 1
    while i >= 0 and text[i] in " \t ":
        i -= 1
    return i < 0 or text[i] in _SENT_END


def check_patterns(
    text: str,
    tokens: list[Token],
    eng: SpellEngine,
    known: set[str],
    ignored: set[str],
) -> list[dict]:
    out: list[dict] = []
    valid = eng.is_valid

    def is_ok(k: str) -> bool:
        return k in known or valid(k)

    consumed: set[int] = set()  # token indexes already explained by a bigram rule

    # --- bigram rules ---------------------------------------------------------------
    for i in range(len(tokens) - 1):
        a, b = tokens[i], tokens[i + 1]
        if text[a.end : b.start].strip() != "" or not text[a.end : b.start]:
            continue
        # "انشاء الله" / "ان شاء الله" -> "إن شاء الله"
        if b.key == "الله" and a.key in ("انشاء", "إنشاء", "انشا"):
            if a.key == "إنشاء" and not (i > 0 and tokens[i - 1].key in ("و", "ف")):
                # «إنشاء الله» is only wrong in the sense of «إن شاء الله»; flag as hint
                conf, sev = 0.7, "warning"
            else:
                conf, sev = 0.9, "error"
            out.append(
                _issue(
                    a.start,
                    b.end,
                    text,
                    "SPLIT_JOIN",
                    sev,
                    ["إن شاء الله"],
                    conf,
                    "الصواب «إن شاء الله» بكلمتين (إن الشرطية + شاء).",
                )
            )
            consumed.update((i, i + 1))
        elif (
            b.key == "شاء" and a.key == "ان" and i + 2 < len(tokens) and tokens[i + 2].key == "الله"
        ):
            out.append(
                _issue(
                    a.start,
                    tokens[i + 2].end,
                    text,
                    "HAMZA_QAT",
                    "error",
                    ["إن شاء الله"],
                    0.9,
                    "«إن» الشرطية تُكتب بهمزة قطع: إن شاء الله.",
                )
            )
            consumed.update((i, i + 1, i + 2))
        # repeated words
        elif a.key == b.key and len(a.key) >= 2:
            if a.key in REPEAT_ALLOWED:
                continue
            if a.key in REPEAT_FUNCTION:
                out.append(_issue(b.start - 0, b.end, text, "REPEATED_WORD", "warning", [""], 0.9))
                # span covers separator + duplicate so that "remove" is a clean suggestion
                out[-1]["start"], out[-1]["word"] = a.end, text[a.end : b.end]
            else:
                out.append(_issue(a.start, b.end, text, "REPEATED_WORD", "info", [a.raw], 0.5))

    # --- per-token rules ------------------------------------------------------------
    for i, t in enumerate(tokens):
        k = t.key
        if i in consumed or k in ignored or len(k) < 2:
            continue
        prev = (
            tokens[i - 1].key if i > 0 and text[tokens[i - 1].end : t.start].strip() == "" else ""
        )
        nxt = (
            tokens[i + 1].key
            if i + 1 < len(tokens) and text[t.end : tokens[i + 1].start].strip() == ""
            else ""
        )
        # strip a leading clitic for closed-list lookups (و/ف)
        base = k
        cl = ""
        if (
            k not in CONFUSABLES
            and len(k) >= 3
            and k[0] in "وف"
            and (k[1:] in CONFUSABLES or k[1:] in ("ان", "انه", "انها", "انهم"))
            and (k[1:].startswith("انه") or not valid(k))
        ):
            cl, base = k[0], k[1:]
        if base in CONFUSABLES:
            c = CONFUSABLES[base]
            out.append(
                _issue(
                    t.start,
                    t.end,
                    text,
                    c["code"],
                    c["severity"],
                    [cl + f for f in c["fix"]],
                    c["confidence"],
                    c["note"],
                )
            )
            continue

        # ان -> إن / أن (context dependent)
        if base == "ان":
            recent = {x.key for x in tokens[max(0, i - 3) : i]}
            if _is_sentence_start(text, t.start) or recent & SAYING_VERBS_IN:
                sugg = [cl + "إن", cl + "أن"]
            else:
                sugg = [cl + "أن", cl + "إن"]
            out.append(
                _issue(
                    t.start,
                    t.end,
                    text,
                    "HAMZA_QAT",
                    "error",
                    sugg,
                    0.6,
                    "همزة «إنّ/أنّ» همزة قطع: «إنّ» بعد القول وأول الجملة و«أنّ» في غيرهما.",
                )
            )
            continue

        # انه -> إنه / أنه (context dependent)
        if base == "انه" or base == "انها" or base == "انهم":
            rest = base[2:]
            sugg_an, sugg_in = "أن" + rest, "إن" + rest
            if _is_sentence_start(text, t.start - len(cl)) or (cl and prev == ""):
                sugg = [cl + sugg_in, cl + sugg_an]
                conf = 0.7
            elif prev in SAYING_VERBS or prev in ("ب", "بأن") or prev.endswith("ب"):
                sugg, conf = [cl + sugg_an, cl + sugg_in], 0.7
            else:
                sugg, conf = [cl + sugg_in, cl + sugg_an], 0.5
            out.append(_issue(t.start, t.end, text, "AN_HU", "info", sugg, conf))
            continue

        if k in known:
            continue

        lex_known = eng.lexicon_known(k)
        ok = valid(k)

        # علي -> على after typical "على" verbs, before a definite noun
        if k == "علي" and nxt.startswith("ال") and prev not in NAME_BEFORE and prev in ALA_VERBS:
            out.append(
                _issue(
                    t.start,
                    t.end,
                    text,
                    "ALEF_MAQSURA",
                    "warning",
                    ["على"],
                    0.7,
                    "إن كنت تقصد حرف الجر فالصواب «على» بألف مقصورة.",
                )
            )
            continue

        # الألف الفارقة: ذهبو -> ذهبوا (written form unknown, +ا is a known word)
        if not ok and k.endswith("و") and len(k) >= 3 and is_ok(k + "ا"):
            out.append(_issue(t.start, t.end, text, "ALEF_FARQA", "warning", [k + "ا"], 0.85))
            continue

        if not ok:
            # التاء المربوطة/الهاء
            if k.endswith("ه") and len(k) >= 3 and is_ok(k[:-1] + "ة"):
                out.append(
                    _issue(t.start, t.end, text, "TAA_MARBUTA", "warning", [k[:-1] + "ة"], 0.85)
                )
                continue
            # ي/ى
            if k.endswith("ي") and len(k) >= 3 and is_ok(k[:-1] + "ى"):
                out.append(
                    _issue(t.start, t.end, text, "ALEF_MAQSURA", "warning", [k[:-1] + "ى"], 0.8)
                )
                continue
            if k.endswith("ى") and len(k) >= 3 and is_ok(k[:-1] + "ي"):
                out.append(
                    _issue(t.start, t.end, text, "ALEF_MAQSURA", "warning", [k[:-1] + "ي"], 0.7)
                )
                continue
            # همزات الألف: إستخدام -> استخدام ، الاسلام -> الإسلام
            cands = [v for v in _variants_alef(k) if v in known or eng.strong_valid(v)]
            if cands:
                wasl = k[0] in "أإآ" and cands[0][0] == "ا"
                code = "HAMZA_WASL" if wasl else "HAMZA_QAT"
                out.append(
                    _issue(
                        t.start,
                        t.end,
                        text,
                        code,
                        "warning" if len(cands) > 1 else "error",
                        cands[:3],
                        0.9 if len(cands) == 1 else 0.6,
                    )
                )
                continue
            # ئ/ؤ/ء
            if k.endswith("يئ") and is_ok(k[:-1] + "ء"):
                out.append(
                    _issue(t.start, t.end, text, "HAMZA_SEAT", "warning", [k[:-1] + "ء"], 0.85)
                )
                continue
            continue

        # valid in Hunspell only because ayaspell is lenient, but a strict-lexicon spelling exists
        if not lex_known:
            if (
                k.startswith("ال")
                and k.endswith("ه")
                and len(k) >= 5
                and k not in eng.hs.stems
                and eng.strong_valid(k[:-1] + "ة")
            ):
                out.append(
                    _issue(t.start, t.end, text, "TAA_MARBUTA", "warning", [k[:-1] + "ة"], 0.8)
                )
                continue
            if k.endswith("يئ") and eng.lexicon_known(k[:-1] + "ء"):
                out.append(_issue(t.start, t.end, text, "HAMZA_SEAT", "error", [k[:-1] + "ء"], 0.9))
            elif "ئ" in k[1:-1] and eng.lexicon_known(k.replace("ئ", "ؤ", 1)):
                out.append(
                    _issue(
                        t.start,
                        t.end,
                        text,
                        "HAMZA_SEAT",
                        "info",
                        [k.replace("ئ", "ؤ", 1)],
                        0.5,
                        "الرسم الأفضل عند مجمع اللغة: الهمزة على الواو.",
                    )
                )

    out.extend(_tanween(text, tokens))
    return out


_TAN_FATHA = "\u064b"
_TANWEEN_ALEF_BAD = re.compile("(\u0629|\u0627\u0621)(?:\u064b\u0627|\u0627\u064b)$")


def _tanween(text: str, tokens: list[Token]) -> list[dict]:
    out: list[dict] = []
    on_alef: list[Token] = []
    on_letter: list[Token] = []
    for t in tokens:
        raw = t.raw
        if _TAN_FATHA not in raw:
            continue
        m = _TANWEEN_ALEF_BAD.search(raw)
        if m:  # مدرسةً / ماءً are right; مدرسةاً / ماءاً are wrong
            fixed = raw[: m.end(1)] + _TAN_FATHA
            out.append(_issue(t.start, t.end, text, "TANWEEN_ALEF", "warning", [fixed], 0.85))
        elif raw.endswith("\u0627\u064b"):
            on_alef.append(t)
        elif raw.endswith("\u064b\u0627"):
            on_letter.append(t)
    if on_alef and on_letter:
        minority = on_alef if len(on_alef) < len(on_letter) else on_letter
        for t in minority:
            raw = t.raw
            swapped = "\u064b\u0627" if raw.endswith("\u0627\u064b") else "\u0627\u064b"
            out.append(
                _issue(t.start, t.end, text, "TANWEEN_STYLE", "info", [raw[:-2] + swapped], 0.4)
            )
    return out
