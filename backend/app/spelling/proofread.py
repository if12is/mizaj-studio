"""Proofreading pipeline: hamza -> spelling -> final ya -> punctuation (suggestions only).

The owner's required order is: 1) proofreading (hamzas, spelling/typos, final ى/ي),
2) punctuation, 3) tashkeel.  This module produces the first two steps as a flat list of
*proposals*; nothing here ever rewrites text (AGENTS.md: base letters are never changed
silently).  Every item is

    {id, start, end, original, replacement, category, code, reason_ar, confidence, ...}

with ``category`` in ``hamza | spelling | ya | punctuation`` and offsets in code points
(``start16``/``end16`` are the UTF-16 offsets the editor uses).  :func:`apply_items`
applies the items the user accepted, after verifying that the text under each span is still
the ``original`` the proposal was made for.

Sources of knowledge (all offline, all local):

* ayaspell/Hunspell and the arramooz lexicon (``SpellEngine``) decide what is a word;
* the word-frequency table that ships with arramooz decides *which spelling is the
  conventional one* (``أحمد`` 384k vs ``احمد`` 0), so the hamza map is derived from data, not
  from a hand-written list;
* a handful of closed context rules cover what a dictionary cannot (``إنّ`` vs ``أنّ``,
  ``علي`` the preposition vs the name, ``المدعى عليه``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from .engine import SpellEngine
from .patterns import check_patterns
from .punct import check_punctuation
from .text import AR_LETTER, MARKS_TATWEEL_RE, Masker, OffsetMap, Token, tokenize

CATEGORIES = ("hamza", "spelling", "ya", "punctuation")
YaStyle = Literal["standard", "egyptian"]

CATEGORY_LABEL_AR = {
    "hamza": "همزات",
    "spelling": "إملاء",
    "ya": "الياء",
    "punctuation": "ترقيم",
}

# --------------------------------------------------------------------------- word lists
CLITICS = (
    "وبال", "وكال", "ولل", "فلل", "وال", "فال", "بال", "كال", "وب", "وك", "ول", "فب",
    "فل", "وس", "فس", "لل", "ال", "و", "ف", "ب", "ل", "ك", "س", "",
)  # fmt: skip
# nouns/verbs whose alef is a hamzat-wasl (so the bare alef is right): never "restored".
WASL_KEEP = {
    "اسم", "اسمه", "اسمها", "اسمك", "اسمي", "اسمى", "اسمين", "ابن", "ابنه", "ابنها",
    "ابني", "ابنى", "ابنك", "ابنة", "ابنته", "ابنتها", "ابنتي", "ابنين", "امرؤ", "امرأ",
    "امرئ", "امرأة", "امرأته", "امراة", "اثنان", "اثنين", "اثنتان", "اثنتين", "اثنا",
    "اثني", "اثنى", "است", "ايمن", "ايم",
}  # fmt: skip
_WASL_RE = (
    re.compile(r"^است[^ا]{2,}"),  # استفعال / استفعل : استئناف، استخدام
    re.compile(r"^ا[^ا]ت[^ا]ا[^ا]"),  # افتعال : اجتماع، اقتضاء، التزام (ال-less)
    re.compile(r"^ان[^ا][^ا]ا[^ا]"),  # انفعال : انعدام، انقطاع
    re.compile(r"^ا[^ا]{2}[^ا]{1}ا[^ا]{1}$"),  # افعلال (احمرار) / افعيلال
)
_WASL_VERB_RE = re.compile(r"^ا(ن[^ا]{3,}|[^ا]ت[^ا]{2,})$")  # انكسر / اجتمع / ابتدأ (verbs)

IN_TRIGGERS = {  # a following «إنّ» (never «أنّ»): حيث إن ، قال إنه
    "حيث", "وحيث", "فحيث", "قال", "قالت", "قالوا", "وقال", "وقالت", "فقال", "فقالت",
    "يقول", "تقول", "ويقول", "ويقولون", "يقولون", "قائلا", "قائلة", "قائلين", "ثم",
}  # fmt: skip
SAY_FAMILY = IN_TRIGGERS - {"حيث", "وحيث", "فحيث", "ثم"}
JUDGE_WORDS = {  # words after which "بان" is almost surely «بأن»
    "قضت", "قضى", "حكمت", "حكم", "أقرت", "أقر", "دفع", "دفعت", "ادعى", "ادعت", "تمسك",
    "تمسكت", "أفاد", "أفادت", "أوضح", "أوضحت", "نص", "تنص", "نصت", "قررت", "قرر", "ذهبت",
    "ذهب", "أكد", "أكدت", "وأفاد", "وقضت", "وقضى", "المحكمة", "النقض", "الحكم", "علما", "علمًا",
}  # fmt: skip
NAME_TITLES = {
    "السيد", "السيدة", "الأستاذ", "الاستاذ", "الأستاذة", "الدكتور", "الدكتورة", "المستشار",
    "المستشارة", "المهندس", "الشيخ", "الحاج", "الأمير", "الإمام", "الامام", "سيدنا", "د",
    "م", "أ", "بن", "ابن", "أبو", "ابو", "عبد", "للسيد", "للدكتور", "للأستاذ", "للمستشار",
    "المحامي", "المحامية", "المدعو", "المدعوة", "الآنسة", "الانسة", "الفاضل", "الفاضلة",
    "السادة", "الأخت", "الاخت", "الرائد", "العقيد", "اللواء", "النقيب", "المساعد", "الفريق",
    "الأخ", "الاخ",
}  # fmt: skip
NAME_FOLLOW = {
    "بن", "ابن", "محمد", "أحمد", "احمد", "محمود", "حسن", "حسين", "حسنين", "عبد", "عبدالله",
    "إبراهيم", "ابراهيم", "مصطفى", "عثمان", "عمر", "خالد", "يوسف", "سعيد", "فهمي", "كامل",
    "رضا", "جمال", "صلاح", "ماهر", "طارق", "ياسر", "رمضان", "إسماعيل", "اسماعيل",
}  # fmt: skip


def _fold_alef(w: str) -> str:
    return w.translate(str.maketrans("أإآ", "ااا"))


def _person_names() -> frozenset[str]:
    """First tokens of the given names in the proper-noun lexicon (without علي itself)."""
    from app.engine.names import builtin_names

    out = set()
    for e in builtin_names():
        if e.note == "person":
            out.add(_fold_alef(e.term.split()[0]))
    out.discard("علي")
    return frozenset(out)


PERSON_NAMES = _person_names()
MASC_AFTER_AYA = {  # أية + <masculine noun> -> أي
    "طلب", "دفع", "دفاع", "حق", "حكم", "أمر", "امر", "إجراء", "اجراء", "قرار", "تعويض",
    "مبلغ", "شخص", "سبب", "وجه", "نص", "شرط", "رسم", "ضرر", "التزام", "طعن", "قيد", "عقد",
    "دليل", "مستند", "عذر", "اعتراض", "تصرف", "تحفظ", "طريق", "أثر", "اثر", "بند", "مطلب",
}  # fmt: skip
# final-ya skip list: words whose ي is right/meaningful (name, «لدي», «إلي» = to me ...).
YA_SKIP = {"علي", "لدي", "إلي", "الي", "ربي", "بي", "لي", "أني", "اني", "إني", "هي", "حي"}
_AN_RE = re.compile(r"^(?P<pre>ول|وب|فب|و|ف|ل|ب|)(?P<h>[اأإ])ن(?P<suf>ه|ها|هم|هما|هن|ني|نا|ك|كم|)$")
# Meaning-changing ي/ى pairs (مُدَّعٍ «plaintiff» vs مُدَّعًى «defendant»): the style flip
# never touches defective-verb participles, present-tense verbs or construct forms.
PARTICIPLES = {
    "مدعي", "قاضي", "باقي", "راعي", "داعي", "ماضي", "جاني", "محامي", "مرمي", "منتهي", "مهتدي",
    "مستدعي", "متعدي", "معتدي", "مشتكي", "مستغني", "متقاضي", "مقضي", "مسوي", "ساعي", "واقي",
    "ناجي", "عاتي", "هادي", "جاري", "آتي", "الآتي", "مبني", "معني", "متوفي", "مستوفي", "مؤدي",
    "مؤتمني", "ثاني", "مفتي", "موصي", "موصى", "مصطفي", "متبني", "مدعو",
}  # fmt: skip
# four-letter (or shorter) nisba adjectives that the fem. «ـية» test cannot cover safely
NISBA_SHORT = {
    "مدني", "كلي", "نسبي", "مالي", "فني", "عملي", "فعلي", "شرعي", "قولي", "أهلي", "ذاتي",
    "حرفي", "رسمي", "جزئي", "عرفي", "ودي", "حسي", "طبي", "علمي", "فكري",
}  # fmt: skip
_FUNC_RE = re.compile(r"^(?:(?:و|ف)?ف|(?:و|ف|ب|ل|ك|ول|وب|فب)?(?:ال)?(?:ذ|ت)|(?:و|ف)?ذ)[يى]$")
_NISBA_END = re.compile("(ائي|اوي|وني|اني|اري|وري|يعي|ادي|اسي|ابي|امي|لمي|عملي|طبي)$")
_REL_RE = re.compile(r"^(?:و|ف|ب|ل|ك|ول|وب|فب)?(?:الذ|الت)[يى]$")
_SHADDA_YA = re.compile("ّ[ً-ِْ]*[يى][ً-ْ]*$")
_ILAYH_RE = re.compile(r"^الي(ه|ها|هم|هما|هن|ك|كم|كما|نا)$")
_MADAA_RE = re.compile(r"^(و|ف|ب|ل|ك|ول|لل|ولل|)(ال)?(مدعي|مسوي)$")
ON_NEXT = {"أن", "ان", "أنه", "انه", "من", "غير", "هذا", "هذه", "ذلك", "ما", "أساس", "عاتقه"}
# frequent legal / administrative words whose bare spelling is dictionary-valid or ambiguous
LEX = {
    "احكام": "أ", "احوال": "أ", "اتعاب": "أ", "اجراء": "إ", "اجراءات": "إ", "اخر": "آ",
    "اخرى": "أ", "اخرين": "آ", "اخرون": "آ", "اية": "أ", "امر": "أ", "اوامر": "أ",
    "امور": "أ", "اساس": "أ", "اساسا": "أ", "اسباب": "أ", "اوراق": "أ", "اقرار": "إ",
    "الزام": "إ", "الغاء": "إ", "اعلان": "إ", "اعلام": "إ", "اصل": "أ", "اصلا": "أ",
    "اثر": "أ", "اطراف": "أ", "ادلة": "أ", "اقامة": "إ", "اثبات": "إ", "ابطال": "إ",
    "ايداع": "إ", "ايجار": "إ", "احد": "أ", "احدى": "إ", "اكثر": "أ", "اقل": "أ",
    "احمد": "أ", "ابراهيم": "إ", "اسماعيل": "إ", "امام": "أ", "اذا": "إ",
    "الا": "إ", "اي": "أ", "ايضا": "أ", "اول": "أ", "اولا": "أ", "اما": "أ", "انما": "إ",
    "اذن": "إ", "اصدار": "إ", "اداء": "أ", "ادارة": "إ", "اداري": "إ", "ادارية": "إ",
    "اشخاص": "أ", "اموال": "أ", "اعمال": "أ", "افراد": "أ", "اقوال": "أ", "اوجه": "أ",
}  # fmt: skip

MSG = {
    "HAMZA_ADD": "همزة القطع: الصواب «{new}» (تُكتب الهمزة على الألف أو تحتها).",
    "HAMZA_WASL": "همزة الوصل: الصواب «{new}» بألف مجردة بلا همزة "
    "(من أوزان افتعال / انفعال / استفعال ومصادرها).",
    "HAMZA_KIND": "نوع الهمزة: الصواب «{new}».",
    "HAMZA_ABU": "«أبو» تُكتب بهمزة قطع على الألف.",
    "AN_IN": "«إنّ» بهمزة تحت الألف بعد «حيث» والقول وفي أول الجملة: «{new}».",
    "AN_AN": "«أنّ» (المصدرية أو المؤكدة) بهمزة فوق الألف في غير موضع الابتداء: «{new}».",
    "AN_FA": "«فإنّ» بهمزة تحت الألف (حرف توكيد بعد الفاء): «{new}».",
    "AN_BA": "«بأنّ» / «لأنّ» بهمزة فوق الألف: «{new}».",
    "ON_ALEF": "حرف الجر «على» يُكتب بألف مقصورة (ى)، لا بياء.",
    "MADAA": "«المدعى عليه» بألف مقصورة (اسم مفعول من «ادّعى»)؛ والمدعي (الخصم) بالياء.",
    "YA_MAQSURA": "ألف مقصورة: الصواب «{new}» (تُكتب بالألف المقصورة لا بالياء).",
    "YA_STD": "الياء آخر الكلمة: الرسم القياسي «{new}» بياء منقوطة.",
    "YA_EGY": "الياء آخر الكلمة: توحيد الرسم على الأسلوب المصري «{new}» بياء غير منقوطة.",
    "AYA_MASC": "«أي» مع المذكر (أيّ طلب)، و«أية» مع المؤنث (أيّة دعوى).",
    "TYPO": "خطأ إملائي محتمل: الصواب «{new}».",
    "NAAT": "«نعت على» (فعل ماضٍ مؤنث من نعى)؛ «نعيت» بياء تعني المتكلمة أو المخاطب.",
    "MUDAIYA": "«مدعية» بتاء مربوطة (المدعية: خصم مؤنث).",
    "TAA_MARBUTA": "التاء المربوطة: الصواب «{new}».",
}


@dataclass(slots=True)
class ProofreadOptions:
    ya_style: YaStyle = "standard"
    categories: tuple[str, ...] = CATEGORIES
    quotes: Literal["keep", "guillemets"] = "keep"


# --------------------------------------------------------------------------- helpers
def _relax(s: str) -> str:
    return s[:-1] + "ي" if s.endswith("ى") else s


def _is_wasl_shape(s: str) -> bool:
    return any(r.match(s) for r in _WASL_RE) or bool(_WASL_VERB_RE.match(s))


def _remap(raw: str, key: str, new_key: str) -> str:
    """Re-spell `raw` as `new_key` keeping its tashkeel when only letters were substituted."""
    if len(key) != len(new_key):
        return new_key
    out: list[str] = []
    i = 0
    for ch in raw:
        if MARKS_TATWEEL_RE.match(ch):
            out.append(ch)
        else:
            out.append(new_key[i] if i < len(new_key) else ch)
            i += 1
    return "".join(out)


def _splits(key: str):
    seen = set()
    for p in CLITICS:
        if key.startswith(p) and len(key) - len(p) >= 2 and p not in seen:
            seen.add(p)
            yield p, key[len(p) :]


class _Ctx:
    """Left/right context of one token: previous word, boundary kind, next word."""

    __slots__ = ("boundary", "next", "prev", "recent", "slash")

    def __init__(
        self, prev: str, boundary: str | None, nxt: str, slash: bool, recent: tuple = ()
    ) -> None:
        self.recent = recent
        self.prev = prev
        self.boundary = boundary
        self.next = nxt
        self.slash = slash


_SENT_PUNCT = set(".!؟?:؛;")
_OPENERS = set('"«“([{')
_TRANSPARENT = set(" \t\u00a0\u200f\u200e-–—*ـ•")


def _left_boundary(text: str, pos: int) -> tuple[str | None, bool]:
    """What stands left of `pos`: sentence start / comma / opening quote / a word (None)."""
    i = pos - 1
    while i >= 0 and text[i] in _TRANSPARENT:
        i -= 1
    slash = i >= 0 and text[i] == "/"
    while i >= 0 and (text[i] in _TRANSPARENT or text[i] == "/"):
        i -= 1
    if i < 0 or text[i] in "\n\r":
        return "start", slash
    c = text[i]
    if c in _SENT_PUNCT:
        return "start", slash
    if c in "،,":
        return "comma", slash
    if c in _OPENERS:
        return "quote_open", slash
    return None, slash


class Proofreader:
    def __init__(self, eng: SpellEngine) -> None:
        self.eng = eng
        self.freq = eng.freq
        self._map: dict[str, list[tuple[str, int]]] | None = None

    # ------------------------------------------------------------------ lexical data
    @property
    def hamza_map(self) -> dict[str, list[tuple[str, int]]]:
        """bare spelling -> hamza spellings, derived from frequencies (bare ≪ hamza)."""
        if self._map is None:
            m: dict[str, list[tuple[str, int]]] = {}
            f = self.freq
            for w, c in f.items():
                if c < 1500 or len(w) < 2 or w[0] not in "أإآ":
                    continue
                bare = "ا" + w[1:]
                if bare in WASL_KEEP or f.get(bare, 0) * 40 >= c:
                    continue
                m.setdefault(bare, []).append((w, c))
            for v in m.values():
                v.sort(key=lambda x: -x[1])
            self._map = m
        return self._map

    def fr(self, w: str) -> int:
        return self.freq.get(w, 0) or self.freq.get(_relax(w), 0)

    def valid(self, w: str, known: set[str]) -> bool:
        return (
            w in known or self.eng.is_valid(w) or (w.endswith("ى") and self.eng.is_valid(_relax(w)))
        )

    def hs_valid(self, w: str, known: set[str]) -> bool:
        return (
            w in known or self.eng.hs.check(w) or (w.endswith("ى") and self.eng.hs.check(_relax(w)))
        )

    # ------------------------------------------------------------------ hamza on one stem
    def _stem_fix(self, stem: str, known: set[str], *, whole_valid: bool, whole_hs: bool):
        """(new_stem, code, confidence, alternatives) or None.  Only the first letter changes."""
        c0 = stem[0]
        sr = _relax(stem)
        if c0 == "ا":
            if sr in WASL_KEEP:
                return None
            hit = LEX.get(sr)
            if hit is not None:
                return hit[0] + stem[1:], "HAMZA_ADD", 0.93, []
            if sr.startswith("ابو") and len(sr) > 3 and not _is_wasl_shape(sr):
                return "أ" + stem[1:], "HAMZA_ABU", 0.92, []
            if _is_wasl_shape(sr):
                return None
            cands = self.hamza_map.get(sr)
            if cands and not (whole_hs and sr.startswith("ال")):
                top = cands[0]
                alts = [w for w, c in cands[1:] if c * 5 >= top[1]]
                return (
                    top[0][0] + stem[1:],
                    "HAMZA_ADD",
                    0.9 if not alts else 0.6,
                    [a[0] + stem[1:] for a in alts],
                )
            if not whole_valid and not sr.startswith("ال"):
                ranked: list[tuple[int, int, int, str]] = []
                for h in "أإآ":
                    v = h + stem[1:]
                    if self.valid(v, known):
                        strong = 1 if (self.eng.strong_valid(_relax(v)) or v in known) else 0
                        ranked.append((strong, self.fr(v), 1 if h == "أ" else 0, h))
                if ranked:
                    ranked.sort(reverse=True)
                    best = ranked[0]
                    close = [r for r in ranked[1:] if r[0] == best[0] and r[1] * 5 >= best[1]]
                    return (
                        best[3] + stem[1:],
                        "HAMZA_ADD",
                        0.88 if not close else 0.6,
                        [r[3] + stem[1:] for r in close],
                    )
            return None
        if c0 in "أإ":
            bare = "ا" + stem[1:]
            br = _relax(bare)
            if _is_wasl_shape(br) and self.valid(bare, known):
                if not self.valid(stem, known) or self.fr(br) >= 20 * max(self.fr(sr), 1):
                    return bare, "HAMZA_WASL", 0.9, []
            elif not self.valid(stem, known):
                other = ("إ" if c0 == "أ" else "أ") + stem[1:]
                if self.valid(other, known) and self.eng.strong_valid(_relax(other)):
                    return other, "HAMZA_KIND", 0.75, []
                if bare in self.eng.hs.stems and bare not in self.hamza_map and br not in LEX:
                    return bare, "HAMZA_WASL", 0.8, []
        return None

    def _hamza_token(self, key: str, known: set[str]):
        whole_valid = self.valid(key, known)
        whole_hs = self.hs_valid(key, known)
        for p, stem in _splits(key):
            if p and whole_hs:
                continue  # a valid word is not re-split (كان، الحق، باب، سالف)
            r = self._stem_fix(stem, known, whole_valid=whole_valid, whole_hs=whole_hs)
            if r is not None:
                new_stem, code, conf, alts = r
                return p + new_stem, code, conf, [p + a for a in alts]
        return None

    # ------------------------------------------------------------------ final ya
    def _style_class_ok(self, key: str, stem: str) -> bool:
        """May the ي/ى style flip touch this word? Only في, الذي/التي and nisba adjectives."""
        if key in ("في", "فى", "ذي", "ذى") or _REL_RE.match(key) or _FUNC_RE.match(key):
            return True
        stems = [_relax(st) for _, st in _splits(key)]
        if any(st in PARTICIPLES for st in stems):
            return False
        if any(st in NISBA_SHORT for st in stems):
            return True
        for st in stems:  # قانوني، نهائي، إداري: nisba suffix AND a real feminine «ـية»
            if len(st) >= 5 and _NISBA_END.search(st) and self.eng.strong_valid(st[:-1] + "ية"):
                return True
        return False  # يدعي، يؤدي، تقضي، التصدي، أمري ...

    def _ya_token(self, key: str, style: YaStyle, known: set[str]):
        """(new_key, code, confidence, is_style) for the final ى/ي letter of one word."""
        if len(key) < 3 and key not in ("في", "فى", "ذي", "ذى"):
            return None
        last = key[-1]
        if last not in "يى":
            return None
        eng = self.eng
        best = None
        for p, stem in _splits(key):
            if len(stem) < (3 if p else 2) or stem in YA_SKIP:
                continue
            alt = stem[:-1] + ("ى" if last == "ي" else "ي")
            f_cur, f_alt = self.freq.get(stem, 0), self.freq.get(alt, 0)
            if last == "ي":
                maqsura_alt = alt in eng.hs.stems or alt in eng.lex
                # etymological ى written with ي (دعوي، حتي، مستشفي): a fix whatever the style
                risky = stem in PARTICIPLES or (
                    stem[0] in "يتنأ" and len(stem) <= 5 and not self._style_class_ok(key, stem)
                )
                if maqsura_alt and not risky and f_alt >= 1500 and f_alt >= 25 * max(f_cur, 1):
                    return p + alt, "YA_MAQSURA", 0.82, False
                ety = f_alt >= max(1500, f_cur // 5) or (
                    f_cur == 0 and f_alt == 0 and alt in eng.lex
                )
                if (
                    style == "egyptian"
                    and not ety
                    and (eng.is_valid(stem) or stem in known)
                    and self._style_class_ok(key, stem)
                ):
                    best = best or (p + alt, "YA_EGY", 0.55, True)
            elif style == "standard":
                if f_cur >= 1500 and f_cur >= 5 * max(f_alt, 1):
                    continue  # attested genuine alef maqsura (لدى، مصطفى، دعوى)
                cur_ok = eng.is_valid(stem) or stem in known
                if not self._style_class_ok(key, stem):
                    continue
                if (eng.is_valid(alt) or alt in known) and (
                    not cur_ok or (f_alt >= 1500 and f_alt >= 5 * max(f_cur, 1))
                ):
                    best = best or (p + alt, "YA_STD", 0.7, True)
        return best

    # ------------------------------------------------------------------ typos
    def _typo(self, key: str, known: set[str]) -> str | None:
        """One deletion / insertion / transposition that yields exactly one common word."""
        n = len(key)
        if n < 4 or n > 14 or self.valid(key, known):
            return None
        cands: dict[str, int] = {}

        def consider(c: str) -> None:
            f = self.freq.get(c, 0)
            if f >= 3000 and c != key:
                cands[c] = f

        for i in range(n):
            consider(key[:i] + key[i + 1 :])
        for i in range(n - 1):
            if key[i] != key[i + 1]:
                consider(key[:i] + key[i + 1] + key[i] + key[i + 2 :])
        for i in range(1, n):
            for ch in "وايمنهل":
                consider(key[:i] + ch + key[i:])
        if not cands:
            return None
        ranked = sorted(cands.items(), key=lambda x: -x[1])
        if len(ranked) > 1 and ranked[1][1] * 4 > ranked[0][1]:
            return None
        return ranked[0][0]

    # ------------------------------------------------------------------ main token pass
    def token_items(
        self,
        text: str,
        tokens: list[Token],
        opt: ProofreadOptions,
        known: set[str],
        ignored: set[str],
    ) -> list[dict]:
        out: list[dict] = []
        n = len(tokens)

        def ctx(i: int) -> _Ctx:
            t = tokens[i]
            b, slash = _left_boundary(text, t.start)
            prev = tokens[i - 1].key if (i > 0 and b is None) else ""
            nxt = ""
            if i + 1 < n:
                gap = text[t.end : tokens[i + 1].start]
                if "\n" not in gap and not any(c in gap for c in ".!؟?؛:"):
                    nxt = tokens[i + 1].key
            recent: list[str] = []
            j = i - 1
            while b is None and j >= 0 and len(recent) < 3:
                gap = text[tokens[j].end : (tokens[j + 1].start if j + 1 < n else t.start)]
                if "\n" in gap or any(c in gap for c in ".!؟?؛:،,"):
                    break
                recent.append(tokens[j].key)
                j -= 1
            return _Ctx(prev, b, nxt, slash, tuple(recent))

        def mk(t: Token, new_key: str, cat: str, code: str, conf: float, **kw) -> dict:
            new = _remap(t.raw, t.key, new_key)
            msg = MSG[code].format(new=new_key) if "{new}" in MSG[code] else MSG[code]
            d = {
                "start": t.start,
                "end": t.end,
                "original": t.raw,
                "replacement": new,
                "category": cat,
                "code": code,
                "reason_ar": msg,
                "confidence": round(conf, 2),
            }
            d.update(kw)
            return d

        # closed lists / dictionary-checked classes of the pattern engine that map cleanly
        pissues = [
            i
            for i in check_patterns(text, tokens, self.eng, known, ignored)
            if i["suggestions"] and i["confidence"] >= 0.8
        ]
        patt = {
            (i["start"], i["end"]): i
            for i in pissues
            if i["code"] in ("TAA_MARBUTA", "SPLIT_JOIN", "ALEF_FARQA", "HAMZA_SEAT")
        }
        starts = {t.start for t in tokens}
        for i in pissues:  # multi-word fixes («ان شاء الله») and repeated function words
            multi = i["code"] in ("SPLIT_JOIN", "HAMZA_QAT") and i["suggestions"][0].count(" ") >= 1
            if i["code"] == "REPEATED_WORD" or (multi and i["end"] - i["start"] > 6):
                if i["start"] in starts or i["code"] == "REPEATED_WORD":
                    cat = "spelling" if i["code"] != "HAMZA_QAT" else "hamza"
                    out.append(
                        {
                            "start": i["start"],
                            "end": i["end"],
                            "original": text[i["start"] : i["end"]],
                            "replacement": i["suggestions"][0],
                            "category": cat,
                            "code": i["code"],
                            "reason_ar": i["message_ar"],
                            "confidence": i["confidence"],
                        }
                    )
        for idx, t in enumerate(tokens):
            k = t.key
            if len(k) < 2 or k in ignored:
                continue
            c = ctx(idx)
            item = self._context_rules(t, k, c, known, mk)
            if item is None and k not in known:
                item = self._lexical(t, k, opt, known, patt, mk)
            if item is not None:
                out.append(item)
        return out

    # ------------------------------------------------------------------ context rules
    def _context_rules(self, t, k, c: _Ctx, known, mk) -> dict | None:  # noqa: ANN001
        m = _AN_RE.match(k)
        if m:
            return self._an_rule(t, k, m, c, mk)
        mi = _ILAYH_RE.match(k)
        if mi:  # إليه / إليها / إليهما ...: «إلى» + pronoun
            return mk(t, "إلي" + mi.group(1), "hamza", "HAMZA_ADD", 0.9)
        if k in ("الي", "الى"):  # «إلى»: bare alef is never right (إلي = to me needs the hamza)
            return mk(t, "إلى", "hamza", "HAMZA_ADD", 0.9 if k == "الى" else 0.82)
        # المدعى عليه / المسوى عليه (the plaintiff is المدعي with a yaa)
        mm = _MADAA_RE.match(k)
        if mm and c.next in ("عليه", "عليها", "عليهم", "عليهما", "عليهن"):
            return mk(t, k[:-1] + "ى", "ya", "MADAA", 0.92)
        # على (preposition) vs علي (name)
        if k in ("علي", "وعلي") and "ّ" not in t.raw:
            if k == "وعلي" and not c.next.startswith("ال"):
                return None
            if c.prev in NAME_TITLES or c.next in NAME_FOLLOW or c.slash:
                return None
            if len(c.prev) > 3 and c.prev[0] in "وف" and c.prev[1:] in NAME_TITLES:
                return None  # والسيد علي
            # next to a known given name it is a name chain (محمد علي، علي محمد), not «على»
            if _fold_alef(c.prev) in PERSON_NAMES or _fold_alef(c.next) in PERSON_NAMES:
                return None
            if c.boundary == "start" and c.next in ("", "بن"):
                return None
            strong = c.next.startswith("ال") or c.next in ON_NEXT
            return mk(t, k[:-1] + "ى", "ya", "ON_ALEF", 0.9 if strong else 0.8)
        # أية + a masculine noun -> أي
        if k in ("اية", "أية") and c.next in MASC_AFTER_AYA:
            return mk(t, "أي", "spelling", "AYA_MASC", 0.82)
        # نعيت على -> نعت على
        if k in ("نعيت", "ونعيت", "فنعيت") and c.next in ("على", "علي"):
            return mk(t, k.replace("نعيت", "نعت"), "spelling", "NAAT", 0.82)
        # «مدعيه» standing alone (between quotes / at a line end) = the feminine plaintiff
        if k == "مدعيه" and (c.boundary in ("quote_open", "start") or c.next == ""):
            return mk(t, "مدعية", "spelling", "MUDAIYA", 0.85)
        return None

    def _an_rule(self, t, k, m, c: _Ctx, mk) -> dict | None:  # noqa: ANN001
        pre, h, suf = m.group("pre"), m.group("h"), m.group("suf")
        if pre in ("ب", "وب", "فب") and suf == "":
            # «بان» is also a real verb (بان الأمر): only in a judging context, or with و/ف
            if h != "ا":
                return None
            if pre != "ب" or (c.next and c.prev in JUDGE_WORDS):
                return mk(t, pre + "أن", "hamza", "AN_BA", 0.82 if pre != "ب" else 0.72)
            return None
        if pre in ("ل", "ول", "ب", "وب", "فب"):
            if suf == "" and not c.next:
                return None
            want, code = "أ", "AN_BA"
        elif pre == "ف":
            if (suf == "" and not c.next) or h == "أ":
                return None
            want, code = "إ", "AN_FA"
        else:  # '' or 'و'
            if (
                c.boundary in ("start", "quote_open", "comma")
                or c.prev in IN_TRIGGERS
                or (suf == "" and set(c.recent) & SAY_FAMILY)
            ):
                want, code = "إ", "AN_IN"
            else:
                want, code = "أ", "AN_AN"
            if h != "ا":
                # an existing hamza is changed only on clear evidence (حيث أن / قال أنه)
                strong = c.prev in {"حيث", "وحيث", "فحيث"} or (
                    set(c.recent) & SAY_FAMILY and suf != ""
                )
                if not (strong and want == "إ" and h == "أ"):
                    return None
        if h == want:
            return None
        conf = 0.85
        if code == "AN_AN" or c.boundary == "comma":
            conf = 0.78
        if pre == "و" and suf == "" and want == "إ":
            conf = 0.7
        alt = pre + ("أ" if want == "إ" else "إ") + "ن" + suf
        return mk(
            t,
            pre + want + "ن" + suf,
            "hamza",
            code,
            conf,
            alternatives=[_remap(t.raw, t.key, alt)],
        )

    # ------------------------------------------------------------------ lexical rules
    def _lexical(self, t, k, opt, known, patt, mk) -> dict | None:  # noqa: ANN001
        # 1. closed lists and dictionary-checked classes of the pattern engine
        p = patt.get((t.start, t.end))
        if p is not None and p["suggestions"][0] != t.raw:
            cat = "hamza" if p["code"] == "HAMZA_SEAT" else "spelling"
            new_key = MARKS_TATWEEL_RE.sub("", p["suggestions"][0])
            it = mk(t, new_key, cat, "TAA_MARBUTA", p["confidence"])
            it["reason_ar"], it["code"] = p["message_ar"], p["code"]
            return it
        # 2. hamza (lexicon, frequency map, dictionary variants, wasl, hamza kind)
        h = self._hamza_token(k, known)
        if h is not None:
            new_key, code, conf, alts = h
            kw = {}
            if alts:
                kw["alternatives"] = [_remap(t.raw, t.key, a) for a in alts]
            extra = ""
            if opt.ya_style == "standard":  # one item for the hamza and the ى->ي of the style
                y = self._ya_token(new_key, "standard", known)
                if y is not None and y[3] and len(y[0]) == len(new_key):
                    new_key, extra = y[0], " وتُكتب الياء آخر الكلمة بالرسم القياسي."
            it = mk(t, new_key, "hamza", code, conf, **kw)
            it["reason_ar"] += extra
            return it
        # 3. final ya (a shadda before the ya = first-person / nisba suffix: left alone)
        y = None if _SHADDA_YA.search(t.raw) else self._ya_token(k, opt.ya_style, known)
        if y is not None:
            new_key, code, conf, is_style = y
            return mk(t, new_key, "ya", code, conf, style=is_style)
        # 4. typo: one deletion / insertion / transposition that yields one common word
        fix = self._typo(k, known)
        if fix:
            return mk(t, fix, "spelling", "TYPO", 0.65)
        return None


# --------------------------------------------------------------------------- punctuation
_PUNCT_CODES = {
    "PUNCT_LATIN_COMMA",
    "PUNCT_LATIN_SEMICOLON",
    "PUNCT_LATIN_QUESTION",
    "PUNCT_SPACE_AFTER_MISSING",
    "PUNCT_BRACKET_SPACE",
    "PUNCT_DOUBLE_SPACE",
}
_QUOTE = re.compile(r'["“”]')
_COLON_DASH = re.compile(r"([:：])[ \t]*[-–—]+[ \t]*(?=\S|\r|\n|$)")
_DOTS = re.compile(r"(?<![\d.])\.{2,}(?![\d.])")
_WAW_SPACE = re.compile(rf"(?<![{AR_LETTER}ـ])(و)([ \t]+)(?=[{AR_LETTER}]{{2,}})")
_SPACE_BEFORE = re.compile(r"(?<=\S)([ \t\u00a0]+)(?=[،؛:.!؟]|\?|;)")
_AR_CH = re.compile(f"[{AR_LETTER}]")
_WS_INNER = " \t\u00a0"
MAX_ELLIPSIS_RUN = 10  # longer runs are fill-in lines («.........»), not typos

MSG_P = {
    "PUNCT_SPACE_BEFORE": "مسافة زائدة قبل علامة الترقيم.",
    "PUNCT_QUOTE_OPEN": "مسافة زائدة بعد علامة الاقتباس الافتتاحية.",
    "PUNCT_QUOTE_CLOSE": "مسافة زائدة قبل علامة الاقتباس الختامية.",
    "PUNCT_COLON_DASH": "«:-» تُكتب «:» وحدها؛ الشرطة بعد النقطتين زائدة.",
    "PUNCT_DOTS2": "نقطتان متتاليتان: يكفي نقطة واحدة.",
    "PUNCT_DOTS": "نقاط متتابعة كثيرة: تُختصر إلى علامة الحذف «…».",
    "PUNCT_WAW_SPACE": "واو العطف تتصل بما بعدها: «وفي» لا «و في».",
    "PUNCT_QUOTE_STYLE": "يُفضَّل استعمال علامتي الاقتباس العربيتين «».",
}


def _pi(text: str, s: int, e: int, repl: str, code: str, reason: str, conf: float) -> dict:
    return {
        "start": s,
        "end": e,
        "original": text[s:e],
        "replacement": repl,
        "category": "punctuation",
        "code": code,
        "reason_ar": reason,
        "confidence": conf,
    }


def _quote_kinds(text: str, ok) -> list[tuple[int, str]]:  # noqa: ANN001
    """(position, 'open'|'close') for each straight / curly double quote.

    A quote is classified from its neighbours when they decide it (`"word` opens, `word"`
    closes); when both sides are boundaries (`" word "`) the open/close alternation decides,
    and every clear quote re-synchronises it, so one unbalanced quote cannot poison the rest.
    """
    out: list[tuple[int, str]] = []
    state_open = False
    n = len(text)
    for m in _QUOTE.finditer(text):
        i = m.start()
        if not ok(i, i + 1):
            continue
        ch = m.group()
        prev = text[i - 1] if i > 0 else "\n"
        nxt = text[i + 1] if i + 1 < n else "\n"
        if ch == "“":
            kind = "open"
        elif ch == "”":
            kind = "close"
        else:
            p_b = prev.isspace() or prev in "([{:،؛-–—/"
            n_b = nxt.isspace() or nxt in ".،؛:!؟?)]}-–—/"
            if p_b and not n_b:
                kind = "open"
            elif n_b and not p_b:
                kind = "close"
            else:
                kind = "close" if state_open else "open"
        state_open = kind == "open"
        out.append((i, kind))
    return out


def punctuation_items(text: str, masker: Masker, opt: ProofreadOptions) -> list[dict]:
    out: list[dict] = []
    n = len(text)

    def ok(s: int, e: int) -> bool:
        return not masker.overlaps(s, max(e, s + 1))

    for i in check_punctuation(text, masker):
        if i["code"] not in _PUNCT_CODES or not i["suggestions"]:
            continue
        s, e = i["start"], i["end"]
        if i["code"] == "PUNCT_DOUBLE_SPACE" and (not 2 <= e - s <= 3 or "\t" in text[s:e]):
            continue  # long runs are layout alignment (headers, columns), not typos
        out.append(
            _pi(text, s, e, i["suggestions"][0], i["code"], i["message_ar"], i["confidence"])
        )

    # space before ، ؛ : . ! ؟ (and before a run of dots), inside Arabic text only
    for m in _SPACE_BEFORE.finditer(text):
        s, e = m.span(1)
        mark = text[e]
        prv = text[s - 1]
        nxt = text[e + 1] if e + 1 < n else ""
        if (
            not ok(s, e)
            or ("a" <= prv.lower() <= "z")  # English typography is left alone
            or not _AR_CH.search(text[max(0, s - 40) : s].rsplit("\n", 1)[-1])
        ):
            continue
        if mark == ":" and prv.isdigit() and text[e + 1 :].lstrip(" \t\u00a0")[:1].isdigit():
            continue  # 10 : 30
        if mark == "." and (nxt.isdigit() or prv in "([{«“" or text[e : e + 3] == "..."):
            continue  # ".5", "( ." and fill-in / elision runs («فيها ........»)
        if prv in "([{«“":
            continue
        if mark in "،؛:" and (_AR_CH.match(nxt) or nxt in '"«“('):
            # «بأن :"النص» -> «بأن: "النص»: move the space after the mark, never glue words
            out.append(
                _pi(text, s, e + 1, mark + " ", "PUNCT_SPACE_BEFORE", MSG_P["PUNCT_SPACE_BEFORE"], 0.9)
            )
            continue
        out.append(_pi(text, s, e, "", "PUNCT_SPACE_BEFORE", MSG_P["PUNCT_SPACE_BEFORE"], 0.9))

    # spaces just inside straight / curly quotes
    for i, kind in _quote_kinds(text, ok):
        if kind == "open" and i + 1 < n and text[i + 1] in _WS_INNER:
            j = i + 1
            while j < n and text[j] in _WS_INNER:
                j += 1
            if j < n and text[j] not in "\r\n" and ok(i + 1, j):
                out.append(
                    _pi(text, i + 1, j, "", "PUNCT_QUOTE_OPEN", MSG_P["PUNCT_QUOTE_OPEN"], 0.9)
                )
        elif kind == "close" and i > 0 and text[i - 1] in _WS_INNER:
            j = i
            while j > 0 and text[j - 1] in _WS_INNER:
                j -= 1
            if j > 0 and text[j - 1] not in "\r\n" and ok(j, i):
                out.append(
                    _pi(text, j, i, "", "PUNCT_QUOTE_CLOSE", MSG_P["PUNCT_QUOTE_CLOSE"], 0.9)
                )

    for m in _COLON_DASH.finditer(text):
        s, e = m.span()
        if ok(s, e):
            eol = e >= n or text[e] in "\r\n"
            out.append(
                _pi(
                    text,
                    s,
                    e,
                    m.group(1) if eol else m.group(1) + " ",
                    "PUNCT_COLON_DASH",
                    MSG_P["PUNCT_COLON_DASH"],
                    0.9,
                )
            )
    for m in _DOTS.finditer(text):
        s, e = m.span()
        if not ok(s, e):
            continue
        run = e - s
        if run == 2:
            out.append(_pi(text, s, e, ".", "PUNCT_DOTS", MSG_P["PUNCT_DOTS2"], 0.8))
        elif 4 <= run <= MAX_ELLIPSIS_RUN:
            out.append(_pi(text, s, e, "…", "PUNCT_DOTS", MSG_P["PUNCT_DOTS"], 0.6))
    for m in _WAW_SPACE.finditer(text):
        s, e = m.span(2)
        if ok(m.start(), e):
            out.append(_pi(text, s, e, "", "PUNCT_WAW_SPACE", MSG_P["PUNCT_WAW_SPACE"], 0.85))
    if opt.quotes == "guillemets":
        for m in re.finditer(r'"([^"\n]{1,300}?)"', text):
            if ok(*m.span()) and _AR_CH.search(m.group(1)):
                out.append(
                    _pi(
                        text,
                        m.start(),
                        m.end(),
                        "«" + m.group(1).strip() + "»",
                        "PUNCT_QUOTE_STYLE",
                        MSG_P["PUNCT_QUOTE_STYLE"],
                        0.6,
                    )
                )
    return out


# --------------------------------------------------------------------------- entry points
def proofread(
    text: str,
    eng: SpellEngine,
    opt: ProofreadOptions | None = None,
    known: set[str] | None = None,
    ignored: set[str] | None = None,
    protected: list[tuple[int, int]] | None = None,
    max_items: int = 5000,
) -> dict:
    opt = opt or ProofreadOptions()
    known = known or set()
    ignored = ignored or set()
    masker = Masker(text, protected)
    pr = _get_proofreader(eng)
    items: list[dict] = []
    base_cats = {"hamza", "spelling", "ya"}
    if base_cats & set(opt.categories):
        tokens = tokenize(text, masker)
        items += pr.token_items(text, tokens, opt, known, ignored)
    if "punctuation" in opt.categories:
        items += punctuation_items(text, masker, opt)
    items = [
        i for i in items if i["category"] in opt.categories and i["original"] != i["replacement"]
    ]
    # one proposal per span: higher confidence wins, then earlier
    items.sort(key=lambda i: (i["start"], -i["confidence"]))
    kept: list[dict] = []
    last_end = -1
    for it in items:
        if it["start"] < last_end:
            continue
        kept.append(it)
        last_end = it["end"]
    truncated = len(kept) > max_items
    kept = kept[:max_items]
    om = OffsetMap(text)
    for n, it in enumerate(kept):
        it["id"] = f"p{n}"
        it["start16"], it["end16"] = om.to16(it["start"]), om.to16(it["end"])
        it["suggestion_only"] = True
    counts = {c: 0 for c in CATEGORIES}
    for it in kept:
        counts[it["category"]] += 1
    return {"items": kept, "counts": counts, "truncated": truncated, "ya_style": opt.ya_style}


def _get_proofreader(eng: SpellEngine) -> Proofreader:
    pr = getattr(eng, "_proofreader", None)
    if pr is None:
        pr = Proofreader(eng)
        eng._proofreader = pr  # type: ignore[attr-defined]
    return pr


def apply_items(text: str, items: list[dict]) -> dict:
    """Apply the accepted proposals; a span whose text changed since is skipped, not forced."""
    ordered = sorted(items, key=lambda i: (i["start"], i["end"]))
    out: list[str] = []
    pos = 0
    applied = 0
    skipped: list[dict] = []
    for it in ordered:
        s, e = int(it["start"]), int(it["end"])
        if s < pos or e > len(text) or text[s:e] != it["original"]:
            skipped.append({"start": s, "end": e, "reason": "stale_or_overlapping"})
            continue
        out.append(text[pos:s])
        out.append(it["replacement"])
        pos = e
        applied += 1
    out.append(text[pos:])
    return {"text": "".join(out), "applied": applied, "skipped": skipped}
