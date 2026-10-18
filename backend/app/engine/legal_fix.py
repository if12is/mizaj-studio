"""Grammar and legal-lexicon corrections applied to the engine output.

Neural diacritizers make systematic mistakes on Egyptian legal prose: case endings after
prepositions / idafa heads, tanween on the first term of an idafa ("رَقْمٌ 90", "تَارِيخٍ 8/2"),
ى/ي and missing-hamza spellings ("عَلِيَّ" for "على", "انْهَا" for "أنَّها"), the nisba shadda,
a few very frequent legal words, ...  This module fixes those classes *systematically* with
deterministic rules and a small lexicon (`data/legal_lexicon.json`).

Hard invariants (same as the whole pipeline):
* only MARKS are changed, never a base letter (the pipeline re-checks this at the end);
* a rule is either a grammatical constraint (a preposition never governs a nominative noun, the
  first term of an idafa never carries tanween, ...) or a lexical fact - never a statistic;
* anything that needs real syntax is NOT implemented (see docs/eval/owner_doc_review.md).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

from app.engine.normalize import SHADDA, canon_marks, engine_letters, split_pairs

DATA = Path(__file__).resolve().parent / "data" / "legal_lexicon.json"

D, F, K = "ُ", "َ", "ِ"
DT, FT, KT = "ٌ", "ً", "ٍ"
SUKUN = "ْ"
VOWEL_MARKS = D + F + K + DT + FT + KT + SUKUN
DIGITS = "0-9٠-٩۰-۹"
_DIGIT_START = re.compile(rf"^[\s(\[]*[{DIGITS}]")
_NUMBER_BEFORE = re.compile(rf"([{DIGITS}][{DIGITS}.,٫٬]*)\s*\)?\s*$")
_DIGIT_MAP = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹", "01234567890123456789")
_SUN = set("تثدذرزسشصضطظنل")
_PFX_MARK = {"و": "وَ", "ف": "فَ", "ب": "بِ", "ك": "كَ", "ل": "لِ"}
_PREFIXES = ["", "و", "ف", "ب", "ك", "ل", "وب", "ول", "وك", "فب", "فل", "فك"]
CASE_MARKS = {"nom": (DT, D), "acc": (FT, F), "gen": (KT, K)}
_CASE_OF = {D: "nom", DT: "nom", F: "acc", FT: "acc", K: "gen", KT: "gen"}
# "ال"-words that are function words, not nouns
_NOT_NOUNS = frozenset(
    "الذي التي الذين اللذين اللذان اللتين اللتان اللاتي اللواتي الا الى الي الان".split()
)
_PRON_SUFFIX = ("ه", "ها", "هم", "هما", "هن", "كم", "كما")
_REAL_H = frozenset({"وجه", "فقه", "شبه", "نزه", "تنزه", "سفه", "جاه", "اله", "الله"})


def norm(bare: str) -> str:
    """Matching key: hamza forms -> alef, alef maqsura -> yaa."""
    for a in "أإآٱ":
        bare = bare.replace(a, "ا")
    return bare.replace("ى", "ي")


# --------------------------------------------------------------------------------------------
# lexicon
# --------------------------------------------------------------------------------------------
@dataclass(frozen=True)
class LexEntry:
    core: str  # bare core letters
    tpl: str  # diacritized core (same letters)
    art: bool  # may carry the article "ال"
    final: str  # "keep": the engine decides the case ending; "form": the template decides


@dataclass(frozen=True)
class Variant:
    prefix: str
    art: bool
    entry: LexEntry


def compose(prefix: str, art: bool, tpl: str) -> str:
    """Diacritized word = prefix particles + (article) + template, with the right sukun/shadda
    on the article's lam. Letters: prefix + ("ال" | merged "لل") + core."""
    pairs = split_pairs(tpl)
    if not pairs:
        return tpl
    merged = art and prefix.endswith("ل")
    out = "".join(_PFX_MARK[ch] for ch in prefix)
    if art:
        sun = pairs[0][0] in _SUN
        if not merged:
            out += "ا"
        out += "ل" if sun else "ل" + SUKUN
        if sun:
            b, m = pairs[0]
            pairs[0] = (b, canon_marks(SHADDA + m))
    return out + "".join(b + m for b, m in pairs)


def _letters(form: str) -> str:
    return "".join(c for c in form if c not in VOWEL_MARKS + SHADDA)


class Lexicon:
    def __init__(self, entries: Iterable[LexEntry], phrases: list[tuple[list[str], list[str]]]):
        self.words: dict[str, Variant] = {}
        for e in entries:
            core = norm(e.core)
            for p in _PREFIXES:
                self.words.setdefault(p + core, Variant(p, False, e))
                if e.art:
                    key = p + ("ل" if p.endswith("ل") else "ال") + core
                    self.words.setdefault(key, Variant(p, True, e))
        self.phrases: dict[str, list[tuple[list[str], list[str]]]] = {}
        for toks, forms in phrases:
            self.phrases.setdefault(norm(toks[0]), []).append(([norm(x) for x in toks], forms))


def load_lexicon(path: Path = DATA) -> Lexicon:
    raw = json.loads(path.read_text(encoding="utf-8"))
    entries: list[LexEntry] = []
    for e in raw["words"]:
        entries.append(
            LexEntry(_letters(e["tpl"]), e["tpl"], bool(e.get("art", True)), e.get("final", "keep"))
        )
    for t in raw["nisba"]:  # tpl ends with "يّ"; the alef-maqsura spelling is matched via norm()
        entries.append(LexEntry(_letters(t), t, True, "keep"))
    phrases = []
    for p in raw["phrases"]:
        forms = p["diacritized"].split(" ")
        phrases.append(([_letters(f) for f in forms], forms))
    lex = Lexicon(entries, phrases)
    lex.nisba = frozenset(norm(_letters(t)) for t in raw["nisba"])
    return lex


_LEX: Lexicon | None = None


def lexicon() -> Lexicon:
    global _LEX
    if _LEX is None:
        _LEX = load_lexicon()
    return _LEX


# --------------------------------------------------------------------------------------------
# token context
# --------------------------------------------------------------------------------------------
@dataclass
class Tok:
    start: int  # index into the pair list (== index in the stripped text)
    end: int
    bare: str  # engine letters (no tatweel / dagger, wasla -> alef)
    idx: list[int]  # engine-letter k -> offset inside the word
    nb: str  # normalized bare


class Ctx:
    def __init__(self, stripped: str, spans, pairs: list[tuple[str, str]], oracle=None) -> None:
        self.s = stripped
        self.pairs = pairs
        self.oracle = oracle
        self.toks: list[Tok] = []
        self.changes = 0
        for m in spans:
            bare, idx = engine_letters(m.group(0))
            self.toks.append(Tok(m.start(), m.end(), bare, idx, norm(bare)))

    # ---- marks ----
    def marks(self, t: Tok, k: int) -> str:
        return self.pairs[t.start + t.idx[k]][1]

    def setm(self, t: Tok, k: int, marks: str) -> bool:
        p = t.start + t.idx[k]
        base, old = self.pairs[p]
        new = canon_marks(marks)
        if canon_marks(old) == new:
            return False
        self.pairs[p] = (base, new)
        self.changes += 1
        return True

    # ---- gaps ----
    def text_after(self, i: int) -> str:
        return self.s[self.toks[i].end :]

    def gap_before(self, i: int) -> str:
        lo = self.toks[i - 1].end if i > 0 else 0
        return self.s[lo : self.toks[i].start]

    def gap_after(self, i: int) -> str:
        hi = self.toks[i + 1].start if i + 1 < len(self.toks) else len(self.s)
        return self.s[self.toks[i].end : hi]

    def adjacent(self, i: int, j: int) -> bool:
        """Tokens i, j=i+1 separated only by blanks (no punctuation / digits / newline)."""
        if j != i + 1 or i < 0 or j >= len(self.toks):
            return False
        g = self.s[self.toks[i].end : self.toks[j].start]
        return g.strip(" \t ") == ""

    # ---- classification ----
    def has_pron(self, t: Tok) -> bool:
        """Word that ends in an attached pronoun (قدره، عليها): its last vowel is not a case."""
        nb = t.nb
        if len(nb) < 4 or t.bare.startswith("ال") or not nb.endswith(_PRON_SUFFIX):
            return False
        if nb.startswith("الي"):  # إليه / إليها
            return True
        if nb in _REAL_H:
            return False
        # جنيه، فقيه، تنبيه end in يه but are not pronoun-suffixed (عليه، فيه، بيه are)
        return not (nb.endswith("يه") and not nb.startswith(("علي", "في", "بي", "لدي", "مني")))

    def is_def(self, t: Tok) -> bool:
        # t.bare keeps the hamza: a verb like ألزمه is not the article + noun
        return t.bare.startswith("ال") and len(t.bare) >= 4 and t.nb not in _NOT_NOUNS

    def is_noun(self, t: Tok) -> bool:
        if self.is_def(t):
            return True
        if t.nb.endswith("ة") and len(t.nb) >= 4:
            return True
        f = getattr(self.oracle, "is_noun_dominant", None)
        if f is not None and len(t.nb) >= 3:
            try:
                return bool(f(t.bare))
            except Exception:  # an analyzer failure must never break diacritization
                return False
        return False

    # ---- case ----
    def case_of(self, t: Tok) -> tuple[str | None, bool]:
        n = len(t.bare)
        if n == 0 or self.has_pron(t):
            return None, False
        if t.bare[-1] == "ا":
            if n >= 2 and FT in self.marks(t, n - 2):
                return "acc", True
            return None, False
        last = self.marks(t, n - 1)
        # sound plural (ـينَ ـونَ) / dual (ـانِ ـينِ?) endings: the last vowel is not a case mark
        if n >= 5 and (
            (t.bare.endswith(("ين", "ون")) and last == F) or (t.bare.endswith("ان") and last == K)
        ):
            return None, False
        for c in last:
            if c in _CASE_OF:
                return _CASE_OF[c], c in (DT, FT, KT)
        return None, False

    def has_tanween(self, t: Tok) -> bool:
        return self.case_of(t)[1]

    def set_case(self, t: Tok, case: str, tanween: bool | None = None) -> bool:
        n = len(t.bare)
        if n == 0 or self.has_pron(t):
            return False
        cur_case, cur_tan = self.case_of(t)
        tan = cur_tan if tanween is None else tanween
        last = t.bare[-1]
        if last == "ا":
            if n < 2:
                return False
            pm = self.marks(t, n - 2)
            if case == "acc" and tan:
                return self.setm(t, n - 2, SHADDA * (SHADDA in pm) + FT)
            if FT in pm and case != "acc":
                return self.setm(t, n - 2, pm.replace(FT, ""))
            return False
        if last == "ى":
            return False
        m = self.marks(t, n - 1)
        shadda = SHADDA if SHADDA in m else ""
        if last == "ي" and not shadda and cur_case is None:
            return False  # invisible case on a bare yaa
        if last == "ي" and not tan and case != "acc" and not shadda:
            return self.setm(t, n - 1, "")
        return self.setm(t, n - 1, shadda + CASE_MARKS[case][0 if tan else 1])

    def drop_tanween(self, t: Tok) -> bool:
        case, tan = self.case_of(t)
        return bool(case and tan and self.set_case(t, case, False))

    def put(self, t: Tok, dia: str, final: str = "keep", offset: int = 0) -> bool:
        """Set the marks of the engine letters of `t` (from `offset`) from the diacritized form
        `dia`. With final="keep" the last letter keeps the engine's case ending (+ the shadda)."""
        pairs = split_pairs(dia)
        if offset + len(pairs) != len(t.bare):
            return False
        if norm("".join(b for b, _ in pairs)) != norm(t.bare[offset:]):
            return False
        changed = False
        for k, (_, m) in enumerate(pairs):
            pos = offset + k
            if m == "" and t.bare[pos] in "أإآ":
                continue  # the template is written without hamza: keep the engine's mark
            if pos == len(t.bare) - 1 and final != "form":
                cur = self.marks(t, pos)
                if SHADDA in m and SHADDA not in cur:
                    changed |= self.setm(t, pos, SHADDA + cur)
                continue
            changed |= self.setm(t, pos, m)
        return changed


# --------------------------------------------------------------------------------------------
# word sets
# --------------------------------------------------------------------------------------------
def _norm_set(words: str) -> frozenset[str]:
    return frozenset(norm(w) for w in words.split())


PREPS = _norm_set("من إلى عن على في")
# nouns / adverbs that are the first term of an idafa: the next noun is genitive
IDAFA_HEADS = _norm_set(
    "بعد قبل عند لدى مع خلال حول دون أمام عقب إزاء ضد بين فوق تحت نحو غير مثل أثناء سوى "
    "عبر تجاه وراء خلف طوال حيال جراء بدل كل بعض أي"
)
TITLES = _norm_set("السيد السيدة الدكتور المستشار الأستاذ المهندس الفاضل")
ORDINALS = _norm_set("الأول الثاني الثالث الرابع الخامس السادس السابع الثامن التاسع العاشر")
DEFENDANT_PRON = _norm_set("عليه عليها عليهم عليهما عليهن")
# المدعى عليه / المدعى به / المدعى فيه: passive participle (the plaintiff is المدعي)
PASSIVE_PARTICIPLE_NEXT = DEFENDANT_PRON | _norm_set("به بها بهم بهما فيه فيها")
# relational nouns that are (almost) always the first term of an idafa
MUDAF_HEADS = _norm_set(
    "فرع قسم مبلغ صندوق رئيس نائب معاون وكيل مدير وحدة إدارة مكتب قلم محكمة براءة "
    "قيمة مقابل أساس هيئة مجلس أمر أمري أمرا إدارة اية ايه"
)
DIRECTIONS = _norm_set("جنوب شمال شرق غرب وسط")
CURRENCIES = _norm_set("جنيه دينار دولار ريال درهم")
DIPTOTE_NAMES = _norm_set("يوسف أحمد عمر عثمان إبراهيم إسماعيل سليمان مصطفى")
WAFA_NEXT = _norm_set("هذا هذه ذلك تلك ذات نفس الصدد ضوء ظل حدود سبيل")
# a name chain ends at these (attached prepositions / conjunctions / relative pronouns)
_B_NAMES = _norm_set("بلال بدر بسام بشير بهاء بكر بيومي بسيوني بخيت")
_L_NAMES = _norm_set("ليلى لطفي لبنى لؤي لمياء لبيب")
_K_NAMES = _norm_set("كريم كمال كامل كرم")


def _variants(cores: str, art: bool = False) -> dict[str, tuple[str, bool, str]]:
    """bare (normalized) word -> (prefix, article, core) for the given cores."""
    out: dict[str, tuple[str, bool, str]] = {}
    for c in cores.split():
        c = norm(c)
        for p in _PREFIXES:
            out.setdefault(p + c, (p, False, c))
            if art:
                key = p + ("ل" if p.endswith("ل") else "ال") + c
                out.setdefault(key, (p, True, c))
    return out


def _strip_wf(nb: str, allowed: frozenset[str]) -> str:
    """`وفي` -> `في` when the stripped form is in `allowed`."""
    if nb[:1] in "وف" and nb[1:] in allowed:
        return nb[1:]
    return nb


# --------------------------------------------------------------------------------------------
# rules
# --------------------------------------------------------------------------------------------
def _lexicon(ctx: Ctx) -> None:
    lex = lexicon()
    toks = ctx.toks
    i = 0
    while i < len(toks):
        t = toks[i]
        hit = False
        for ptoks, forms in lex.phrases.get(t.nb, ()):
            n = len(ptoks)
            if i + n <= len(toks) and all(toks[i + j].nb == ptoks[j] for j in range(n)):
                if all(ctx.adjacent(i + j, i + j + 1) for j in range(n - 1)):
                    for j in range(n):
                        ctx.put(toks[i + j], forms[j], "form")
                    i += n
                    hit = True
                    break
        if hit:
            continue
        v = lex.words.get(t.nb)
        if v is not None:
            ctx.put(t, compose(v.prefix, v.art, v.entry.tpl), v.entry.final)
        i += 1


def _article_alef(ctx: Ctx) -> None:
    """`وَاَلَّذِي` / `اَلْعَامِّ` -> `وَالَّذِي` / `الْعَامِّ`: the alef of the article never
    carries a vowel. Also repairs a doubled tanween (`عَمَلًاً` -> `عَمَلًا`)."""
    for t in ctx.toks:
        n = len(t.bare)
        if n >= 2 and t.bare[-1] == "ا" and FT in ctx.marks(t, n - 1) and FT in ctx.marks(t, n - 2):
            ctx.setm(t, n - 1, "")
        for p in ("", "و", "ف", "ب", "ك", "ل"):
            if (
                t.bare.startswith(p + "ال")
                and len(t.bare) > len(p) + 3
                and "الله" not in t.bare[:5]
            ):
                a = len(p)
                if ctx.marks(t, a):
                    ctx.setm(t, a, "")
                break


def _heading(ctx: Ctx) -> None:
    """A heading that is a single definite word (`الدِّفَاعِ` ، `الْوَاقِعَاتِ`) is nominative."""
    if (
        len(ctx.toks) == 1
        and ctx.is_def(ctx.toks[0])
        and not re.search(
            r"[\w]",
            ctx.s.replace(ctx.s[ctx.toks[0].start : ctx.toks[0].end], "", 1).replace("ـ", ""),
        )
    ):
        if ctx.case_of(ctx.toks[0])[0] in ("gen", "acc"):
            ctx.set_case(ctx.toks[0], "nom")


def _hamza_below(ctx: Ctx) -> None:
    """`إلَّا` -> `إِلَّا`: an initial hamza-below always takes its kasra (the engine drops it);
    the single-letter abbreviation `ص` (page) carries no mark."""
    for t in ctx.toks:
        if t.bare[:1] == "إ" and not ctx.marks(t, 0):
            ctx.setm(t, 0, K)
        elif t.bare == "ص":
            ctx.setm(t, 0, "")


def _qalam_kuttab(ctx: Ctx) -> None:
    """`قَلَمِ الْكِتَابِ` -> `قَلَمِ الْكُتَّابِ`: the clerks' office (not the book)."""
    toks = ctx.toks
    for i, t in enumerate(toks[1:], 1):
        if t.nb not in ("الكتاب", "كتاب") or not ctx.adjacent(i - 1, i):
            continue
        if toks[i - 1].nb not in ("قلم", "بقلم", "لقلم", "وقلم"):
            continue
        ctx.put(t, "الْكُتَّاب" if t.nb == "الكتاب" else "كُتَّاب")


def _min_sukun(ctx: Ctx) -> None:
    """`مِنْ الْ...` -> `مِنَ الْ...`, `عَنْ الْ...` -> `عَنِ الْ...` (sukun meets hamzat wasl)."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        core = _strip_wf(t.nb, frozenset({"من", "عن", "او", "قد"}))
        # a feminine past verb ends in ـتْ (قَضَتْ ، أَصْدَرَتْ): kasra before the article
        fem_verb = len(t.bare) >= 4 and t.bare.endswith("ت") and not t.bare.startswith("ال")
        if core not in ("من", "عن", "او", "قد") and not fem_verb:
            continue
        if not (ctx.adjacent(i, i + 1) and ctx.is_def(toks[i + 1])):
            continue
        k = len(t.bare) - 1
        if ctx.marks(t, k) in ("", SUKUN):
            ctx.setm(t, k, F if core == "من" else K)


_NAME_BEFORE_ALI = _norm_set("محمد أحمد السيد الدكتور الأستاذ أبو بن ابن")
_NAMES_AFTER_ALI = _norm_set("محمد أحمد محمود حسن حسين مصطفى عمر عثمان يوسف خالد إبراهيم")


def _alif_maqsura_preps(ctx: Ctx) -> None:
    """`علي` / `الي` typed with yaa before a definite noun: the preposition `على` / `إلى`."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        core = _strip_wf(t.nb, frozenset({"علي", "الي"}))
        if core not in ("علي", "الي") or not ctx.adjacent(i, i + 1):
            continue
        nxt = toks[i + 1]
        if not (
            ctx.is_def(nxt)
            or nxt.nb in ("ان", "انه", "انها", "انهم", "انهما")
            or (ctx.is_noun(nxt) and nxt.nb not in _NAMES_AFTER_ALI)
        ):
            continue
        if i > 0 and ctx.adjacent(i - 1, i) and toks[i - 1].nb in _NAME_BEFORE_ALI:
            continue
        n = len(t.bare)
        if core == "علي":
            ctx.setm(t, n - 2, F)
        else:
            ctx.setm(t, n - 3, K)
            ctx.setm(t, n - 2, F)
        ctx.setm(t, n - 1, "")


def _wafa(ctx: Ctx) -> None:
    """`وفى هذا الشأن`: the preposition `وَفِي`, not the verb `وَفَى`."""
    for i, t in enumerate(ctx.toks[:-1]):
        if t.nb == "وفي" and ctx.adjacent(i, i + 1) and ctx.toks[i + 1].nb in WAFA_NEXT:
            ctx.setm(t, 0, F)
            ctx.setm(t, 1, K)
            ctx.setm(t, 2, "")


def _mudda3a(ctx: Ctx) -> None:
    """المدعى عليه (defendant, passive participle) vs المدعي (plaintiff; often spelled المدعى)."""
    v = _variants("مدعي", art=True)
    toks = ctx.toks
    for i, t in enumerate(toks):
        if t.nb not in v:
            continue
        nxt = toks[i + 1] if ctx.adjacent(i, i + 1) else None
        n = len(t.bare)
        if nxt is not None and nxt.nb in PASSIVE_PARTICIPLE_NEXT:
            if not {F, FT} & set(ctx.marks(t, n - 2)):
                ctx.setm(t, n - 2, F)
            if not ctx.marks(t, n - 1).strip(SHADDA):
                ctx.setm(t, n - 1, "")
        elif t.bare.endswith("ى"):
            ctx.setm(t, n - 2, K)


def _agree_case(ctx: Ctx, i: int) -> str | None:
    """Case of the noun the word at `i` is in apposition to (the previous word)."""
    if i == 0 or not ctx.adjacent(i - 1, i):
        return None
    p = ctx.toks[i - 1]
    case, _ = ctx.case_of(p)
    if case is not None:
        return case
    if p.bare[-1] in "ىا" and i >= 2 and ctx.adjacent(i - 2, i - 1):  # maqsur noun: its governor
        if _strip_wf(ctx.toks[i - 2].nb, PREPS) in PREPS:
            return "gen"
    return None


def _number_noun_idafa(ctx: Ctx) -> None:
    """`رَقْمٌ 90` -> `رَقْمُ 90`: the first term of an idafa never carries tanween; `رقم` /
    `طبعة` agree with the previous noun; `سنة` after ل or a digit is `سَنَةِ`, not `سُنَّة`."""
    v = _variants("رقم تاريخ سنة جلسة طبعة صفحة")
    for i, t in enumerate(ctx.toks):
        hit = v.get(t.nb)
        if hit is None:
            continue
        prefix, _, core = hit
        before_digit = bool(_DIGIT_START.match(ctx.text_after(i)))
        if core == "سنة":
            if not (before_digit or prefix.endswith("ل")):
                continue
            ctx.setm(t, len(prefix), F)
            ctx.setm(t, len(prefix) + 1, F)
        elif not before_digit:
            continue
        agree = _agree_case(ctx, i)
        if prefix.endswith(("ب", "ل")):
            case = "gen"
        elif core == "رقم" or core == "سنة":
            case = agree or ("gen" if core == "سنة" else "nom")
        elif core == "جلسة":
            case = "gen" if agree else "nom"  # `حُكْمُ جَلْسَةِ ...` / `ق جَلْسَةُ ...`
        else:
            case = "gen"
        ctx.set_case(t, case, False)


def _currency(ctx: Ctx) -> None:
    """Case of the tamyiz after a figure: a fraction or 11-99 (last two digits) -> accusative;
    multiples of 100 -> genitive (3-10 would be a plural: not touched)."""
    v = _variants(" ".join(CURRENCIES))
    for t in ctx.toks:
        if t.nb not in v:
            continue
        m = _NUMBER_BEFORE.search(ctx.s[: t.start])
        if not m:
            continue
        txt = m.group(1).translate(_DIGIT_MAP).replace("٫", ".").replace("٬", "")
        txt = txt.replace(",", "")
        whole, _, frac = txt.partition(".")
        try:
            n = int(whole or 0)
        except ValueError:
            continue
        if frac.strip("0"):
            case = "acc"
        elif n < 11:
            continue
        elif n % 100 == 0:
            case = "gen"
        elif n % 100 >= 11:
            case = "acc"
        else:
            continue
        last = t.bare[-1]
        if case == "gen":
            if last not in "اى":
                ctx.set_case(t, "gen", True)
        elif last == "ا":
            ctx.set_case(t, "acc", True)
        elif last != "ى":  # no alef to carry the fathatan: written with the genitive tanween
            ctx.set_case(t, "gen", True)


def _prep_governs_genitive(ctx: Ctx) -> None:
    """A preposition / idafa head is followed by a genitive noun, never a nominative one."""
    toks = ctx.toks
    heads = PREPS | IDAFA_HEADS
    for i, t in enumerate(toks[:-1]):
        if _strip_wf(t.nb, heads) not in heads or not ctx.adjacent(i, i + 1):
            continue
        nxt = toks[i + 1]
        if not ctx.is_noun(nxt) or nxt.bare[-1] in "اى" or ctx.has_pron(nxt):
            continue
        if nxt.nb.endswith(("ون", "ان")):
            continue
        case, tan = ctx.case_of(nxt)
        if case is None or case == "gen":
            continue
        # definite: any non-genitive ending is wrong; indefinite: a bare fatha may be a
        # diptote's genitive, so only damma / dammatan / fathatan are corrected - unless the
        # word is itself the first term of an idafa (a mudaf is never diptote-marked)
        mudaf = (
            i + 2 < len(toks)
            and ctx.adjacent(i + 1, i + 2)
            and (ctx.is_def(toks[i + 2]) or ctx.case_of(toks[i + 2]) == ("gen", False))
        )
        if ctx.is_def(nxt) or case == "nom" or tan or mudaf:
            ctx.set_case(nxt, "gen", False if mudaf else None)


def _anna(ctx: Ctx) -> None:
    """`انِ الْمُدَّعِي` / `أَنْ الْوَزِيرَ`: أنّ / إنّ before a definite noun (the subjunctive `أَنْ`
    takes a verb); its noun is accusative."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        if t.nb not in ("ان", "وان", "فان", "بان") or not ctx.adjacent(i, i + 1):
            continue
        nxt = toks[i + 1]
        if not ctx.is_def(nxt) or nxt.nb.startswith("الي") or ctx.has_pron(nxt):
            continue
        n = len(t.bare)
        if ctx.marks(t, n - 1) in ("", SUKUN, K):
            ctx.setm(t, n - 1, SHADDA + F)
            if nxt.bare[-1] not in "اى" and not nxt.nb.endswith(("ون", "ان")):
                ctx.set_case(nxt, "acc")


def _mudaf_heads(ctx: Ctx) -> None:
    """Relational nouns (فرع، صندوق، رئيس، محكمة ...): no tanween before their complement, which
    is genitive."""
    v = _variants(" ".join(MUDAF_HEADS))
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        if t.nb not in v or not ctx.has_tanween(t) or not ctx.adjacent(i, i + 1):
            continue
        nxt = toks[i + 1]
        if not (ctx.is_noun(nxt) or ctx.has_tanween(nxt) or nxt.nb in ("ابو", "ابي")):
            continue
        ctx.drop_tanween(t)
        if ctx.case_of(nxt)[0] in ("nom", "acc"):
            ctx.set_case(nxt, "gen")


def _idafa_tanween(ctx: Ctx) -> None:
    """tanween + a definite genitive noun: `قَلَمٌ الْكِتَابِ` -> `قَلَمُ الْكِتَابِ`."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        nxt = toks[i + 1]
        if not (ctx.has_tanween(t) and ctx.adjacent(i, i + 1) and ctx.is_def(nxt)):
            continue
        if ctx.case_of(nxt) == ("gen", False):
            ctx.drop_tanween(t)


def _ghayr_tanween(ctx: Ctx) -> None:
    """`غَيْرَ مَقْبُولِ` -> `غَيْرَ مَقْبُولٍ`: the indefinite genitive after غير takes tanween."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        if t.nb != "غير" or not ctx.adjacent(i, i + 1):
            continue
        nxt = toks[i + 1]
        if ctx.is_def(nxt) or nxt.bare[-1] in "اىي" or ctx.has_pron(nxt):
            continue
        if not (ctx.is_noun(nxt) or nxt.nb.startswith("م")):
            continue
        if i + 2 < len(toks) and ctx.adjacent(i + 1, i + 2):
            n2 = toks[i + 2]
            if ctx.is_def(n2) or ctx.marks(n2, len(n2.bare) - 1) == K:
                continue  # possibly the head of an idafa
        if ctx.case_of(nxt) == ("gen", False):
            ctx.set_case(nxt, "gen", True)


def _ba_anna(ctx: Ctx) -> None:
    """`بأن:` / `وبأن "...` introducing a quotation: `بِأَنَّ`."""
    for i, t in enumerate(ctx.toks):
        if t.nb not in ("بان", "وبان", "فبان"):
            continue
        if not re.match(r'^\s*[:"“«(]', ctx.text_after(i)):
            continue
        n = len(t.bare)
        ctx.setm(t, n - 1, SHADDA + F)
        ctx.setm(t, n - 2, F)
        ctx.setm(t, n - 3, K)
        if n == 4:
            ctx.setm(t, 0, F)


def _dhidd(ctx: Ctx) -> None:
    """`الْمَطْعُونِ ضِدُّهُ` -> `ضِدَّهُ`; `ضِدُّ الْ...` -> `ضِدَّ` (adverb of place)."""
    toks = ctx.toks
    for i, t in enumerate(toks):
        fix = False
        if t.nb in ("ضده", "ضدها", "ضدهم", "ضدهما", "ضدهن") and i > 0 and ctx.adjacent(i - 1, i):
            fix = toks[i - 1].nb in ("مطعون", "المطعون", "محكوم", "المحكوم", "المقضي", "للمطعون")
        elif (
            t.nb == "ضد"
            and i + 1 < len(toks)
            and ctx.adjacent(i, i + 1)
            and ctx.is_def(toks[i + 1])
        ):
            fix = (toks[i - 1].nb if i > 0 else "") not in ("هو", "هي", "كان", "ليس")
        if fix:
            ctx.setm(t, 0, K)
            ctx.setm(t, 1, SHADDA + F)


def _amr_taqdir(ctx: Ctx) -> None:
    """`امرى تقدير الرسوم`: dual `أَمْرَيْ` + genitive `تَقْدِيرِ` (the engine reads "my order")."""
    toks = ctx.toks
    v = _variants("امري امرا")
    for i, t in enumerate(toks[:-1]):
        hit = v.get(t.nb)
        if hit is None or not ctx.adjacent(i, i + 1) or toks[i + 1].nb not in ("تقدير", "التقدير"):
            continue
        prefix, _, core = hit
        dia = "اَمْرَيْ" if core.endswith("ي") else "اَمْرَا"
        ctx.put(t, dia, "form", offset=len(prefix))
        if core.endswith("ي") and ctx.is_def(toks[i + 1]):
            ctx.setm(t, len(t.bare) - 1, K)  # `أَمْرَيِ التَّقْدِيرِ` (kasra before hamzat wasl)
        ctx.set_case(toks[i + 1], "gen", False)


def _alzamahu(ctx: Ctx) -> None:
    """`الذي أَلْزَمَهُ الْحُكْمَ بِمَصْرُوفَاتِ`: the noun after verb + pronoun, when the verb takes a
    `ب` complement, is the subject."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-2]):
        if t.nb in ("الزمه", "الزمها", "الزمهم", "الزمهما") and ctx.adjacent(i, i + 1):
            if (
                ctx.is_def(toks[i + 1])
                and ctx.adjacent(i + 1, i + 2)
                and toks[i + 2].nb.startswith("ب")
            ):
                ctx.set_case(toks[i + 1], "nom")


def _passive_verbs(ctx: Ctx) -> None:
    """Legal verbs that are (almost) always passive in the construction they appear in."""
    toks = ctx.toks
    for i, t in enumerate(toks):
        nxt = toks[i + 1] if ctx.adjacent(i, i + 1) else None
        nxt2 = toks[i + 2] if nxt is not None and ctx.adjacent(i + 1, i + 2) else None
        off = 1 if t.nb[:1] in "وف" and len(t.nb) > 3 and t.nb[1:] in _PASSIVE_CORES else 0
        core = t.nb[off:]
        dia = final = None
        # `يُلْزَمُ بِأَدَاءِ ...` / `يُلْزَمُ الْمُدَّعِي بِأَدَاءِ ...`: a verb whose complement is
        # introduced by ب and which has no subject of its own is passive
        by_b = nxt is not None and (
            nxt.nb.startswith("ب")
            or (ctx.is_def(nxt) and nxt2 is not None and nxt2.nb.startswith("ب"))
        )
        if core in ("يلزم", "تلزم") and by_b:
            dia, final = core[0] + "ُلْزَم", "keep"
        elif core in ("اعلنت", "اعلن") and nxt is not None and nxt.nb.startswith("ب"):
            dia, final = t.bare[off] + ("ُعْلِنَتْ" if core == "اعلنت" else "ُعْلِنَ"), "form"
        elif (
            core in ("يعلن", "تعلن")
            and nxt is not None
            and (nxt.nb.startswith("ب") or nxt.nb in ("هذا", "هذه"))
        ):
            dia, final = core[0] + "ُعْلَن", "keep"
        elif core == "حكم" and nxt is not None and nxt.nb in DEFENDANT_PRON:
            dia, final = "حُكِمَ", "form"
        if dia:
            ctx.put(t, dia, final or "keep", offset=off)


_PASSIVE_CORES = frozenset({"يلزم", "تلزم", "اعلنت", "اعلن", "يعلن", "تعلن", "يستحق", "حكم"})


def _fem_adjective(ctx: Ctx) -> None:
    """PREP + definite feminine noun + definite feminine adjective: the adjective agrees in case
    (`فِي الدَّعْوَى الْأَصْلِيَّةُ` -> `الْأَصْلِيَّةِ`)."""
    toks = ctx.toks
    for i in range(2, len(toks)):
        adj, noun, gov = toks[i], toks[i - 1], toks[i - 2]
        if not (ctx.adjacent(i - 1, i) and ctx.adjacent(i - 2, i - 1)):
            continue
        if not (adj.nb.startswith("ال") and adj.nb.endswith("ية") and ctx.is_def(noun)):
            continue
        if not (noun.nb.endswith("ة") or noun.bare[-1] in "ىا"):
            continue
        if _strip_wf(gov.nb, PREPS) not in PREPS:
            continue
        ctx.set_case(adj, ctx.case_of(noun)[0] or "gen")


def _conj_genitive(ctx: Ctx) -> None:
    """`الْقَضَائِيَّةِ وَرُسُومُ التَّوْثِيقِ`: wa + definite noun right after a genitive definite
    noun, followed by a genitive complement or by punctuation (so not a new clause) -> genitive."""
    toks = ctx.toks
    for i in range(1, len(toks)):
        t = toks[i]
        if not (t.bare.startswith("وال") and len(t.bare) >= 6 and ctx.adjacent(i - 1, i)):
            continue
        p = toks[i - 1]
        if not (ctx.is_def(p) and ctx.case_of(p)[0] == "gen"):
            continue
        case = ctx.case_of(t)[0]
        if case is None or case == "gen":
            continue
        if i + 1 >= len(toks) or not ctx.adjacent(i, i + 1):
            ok = True  # punctuation / end of the sentence follows
        else:
            nxt = toks[i + 1]
            ok = (ctx.is_def(nxt) and ctx.case_of(nxt)[0] == "gen") or bool(
                re.match(r"^[بلك]ال", nxt.nb)
            )
        if ok:
            ctx.set_case(t, "gen")
    # indefinite idafa head: `الْقَضَائِيَّةِ وَرُسُومُ التَّوْثِيقِ`
    for i in range(1, len(toks) - 1):
        t = toks[i]
        if not (t.nb.startswith("و") and not t.bare.startswith("وال") and ctx.adjacent(i - 1, i)):
            continue
        p, nxt = toks[i - 1], toks[i + 1]
        if not (ctx.is_def(p) and ctx.case_of(p)[0] == "gen"):
            continue
        if ctx.case_of(t)[0] in ("nom", "acc") and ctx.adjacent(i, i + 1) and ctx.is_noun(t):
            if ctx.is_def(nxt) and ctx.case_of(nxt) == ("gen", False):
                ctx.set_case(t, "gen", False)


# ---- titles, names and appositive lists ------------------------------------------------------
def _chain_break(nb: str) -> bool:
    if re.match(r"^(وال|لل|[بلك]ال|واخر)", nb) or nb in ("او", "ثم", "الذي", "التي", "و"):
        return True
    if nb[:1] == "ب" and nb not in _B_NAMES:
        return True
    if nb[:1] == "ل" and nb not in _L_NAMES:
        return True
    if nb[:1] == "ك" and nb not in _K_NAMES:
        return True
    return nb in ("في", "فيما", "فقد", "فان", "فهو", "فلا", "حيث", "بصفته")


def _chain(ctx: Ctx, head: int, case: str) -> int:
    """Case for a title / name chain: the head gets `case`, middle terms are idafa (genitive,
    no tanween), the last term is genitive with its tanween (diptote names: none). Returns the
    index of the last member."""
    toks = ctx.toks
    members = [head]
    j = head + 1
    while (
        j < len(toks)
        and len(members) < 6
        and ctx.adjacent(j - 1, j)
        and not _chain_break(toks[j].nb)
    ):
        members.append(j)
        j += 1
    for pos, m in enumerate(members):
        tm = toks[m]
        last = pos == len(members) - 1
        c = case if pos == 0 else "gen"
        if tm.nb in DIPTOTE_NAMES and last:
            ctx.set_case(tm, c, False)
        elif last and pos > 0:
            ctx.set_case(tm, c)
        elif last:
            ctx.set_case(tm, c)  # a single term keeps the engine's tanween
        else:
            ctx.set_case(tm, c, False)
            n = len(tm.bare)
            if tm.bare[-1] == "ا" and n >= 2 and FT in ctx.marks(tm, n - 2):
                ctx.setm(tm, n - 2, ctx.marks(tm, n - 2).replace(FT, ""))
    return members[-1]


def _governed(ctx: Ctx, i: int) -> str | None:
    """'gen' when the word at `i` is governed by a preposition / idafa head."""
    t = ctx.toks[i]
    if re.match(r"^[وف]?(لل|بال|كال)", t.nb):
        return "gen"
    if i > 0 and ctx.adjacent(i - 1, i):
        g = _strip_wf(ctx.toks[i - 1].nb, PREPS | IDAFA_HEADS)
        if g in PREPS or g in IDAFA_HEADS:
            return "gen"
    return None


def _apposition(ctx: Ctx, h: int, case: str, handled: set[int]) -> int | None:
    toks = ctx.toks
    handled.add(h)
    if toks[h].nb in TITLES and re.match(r"^\s*/", ctx.text_after(h)):
        ctx.set_case(toks[h], case)
        if h + 1 >= len(toks):
            return None
        last = _chain(ctx, h + 1, case)
    else:
        last = _chain(ctx, h, case)
    for k in range(last, len(toks)):  # next list item: after a comma, before the closing bracket
        g = ctx.gap_after(k)
        if re.match(r"^\s*[،,]\s*$", g) and k + 1 < len(toks):
            return k + 1
        if ")" in g or "\n" in g:
            break
    return None


def _titles_and_lists(ctx: Ctx) -> None:
    toks = ctx.toks
    n = len(toks)
    # 1) ordinals after "المدعى عليهما": `الثاني والثالث` take the case of the governor
    ord_case: dict[int, str] = {}
    for i, t in enumerate(toks):
        if t.nb not in ORDINALS or i < 2 or not ctx.adjacent(i - 1, i):
            continue
        if not toks[i - 1].nb.startswith("علي") or len(toks[i - 1].nb) > 6:
            continue
        gov = _governed(ctx, i - 2)
        if gov is None:
            continue
        j = i
        while j + 1 < n and ctx.adjacent(j, j + 1):
            nb = toks[j + 1].nb
            if nb.startswith("و") and nb[1:] in ORDINALS:
                j += 1
            else:
                break
        for k in range(i, j + 1):
            ctx.set_case(toks[k], gov)
        ord_case[j] = gov
    # 2) a parenthetical right after the ordinals is in apposition to them
    handled: set[int] = set()
    for i in range(1, n):
        if (i - 1) in ord_case and re.search(r"\(\s*$", ctx.gap_before(i)):
            h: int | None = i
            while h is not None:
                h = _apposition(ctx, h, ord_case[i - 1], handled)
    # 3) every other `السيد/ ...`
    for i, t in enumerate(toks):
        if i in handled or t.nb not in TITLES or i + 1 >= n:
            continue
        if not re.match(r"^\s*/", ctx.text_after(i)) or ctx.gap_after(i).strip(" / "):
            continue
        case = ctx.case_of(t)[0]
        if case is not None:
            _chain(ctx, i + 1, case)


_KANA = _norm_set("كان كانت يكون تكون ليكون وليكون فيكون وكان وكانت ليس ليست أصبح صار")


def _nisba_case(ctx: Ctx) -> None:
    """Nisba adjectives (`مدنى كلى` ، `الاجمالى` ، `نسبى`): the case mark sits on the shadda
    even when the yaa is written as alef maqsura; after a figure (`لسنة 2026 مدنى كلى`) and
    after كان it is nominative, after a preposition genitive; a second nisba copies the first."""
    nis = lexicon().nisba
    toks = ctx.toks
    for i, t in enumerate(toks):
        core = t.nb[2:] if t.nb.startswith("ال") else t.nb
        if core not in nis or t.bare[-1] not in "ىي":
            continue
        d = ctx.is_def(t)
        prev = toks[i - 1] if i > 0 and ctx.adjacent(i - 1, i) else None
        figure = bool(re.search(rf"[{DIGITS}]\s*$", ctx.s[: t.start]))
        case = tan = None
        pcore = (prev.nb[2:] if prev.nb.startswith("ال") else prev.nb) if prev is not None else ""
        if prev is not None and pcore in nis:
            case, tan = ctx.case_of(prev)
            if t.bare[-1] == "ى" and case is None:
                case = None
        elif prev is not None and prev.nb in _KANA and d:
            case, tan = "nom", False
        elif prev is not None and _strip_wf(prev.nb, PREPS) in PREPS:
            case, tan = "gen", not d
        elif figure and not d:
            case, tan = "nom", True
        if case is None:
            continue
        ctx.setm(t, len(t.bare) - 1, SHADDA + CASE_MARKS[case][0 if (tan and not d) else 1])


def _mahall(ctx: Ctx) -> None:
    """`مَحَلَّ التَّدَاعِي` -> `مَحَلِّ التَّدَاعِي`; `الطَّعْنِ رَقْمُ` -> `الطَّعْنُ رَقْمُ`."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        if t.nb == "محل" and ctx.adjacent(i, i + 1) and ctx.is_def(toks[i + 1]):
            ctx.set_case(t, "gen", False)
        if t.nb == "الطعن" and ctx.adjacent(i, i + 1) and toks[i + 1].nb == "رقم":
            prev = toks[i - 1].nb if i > 0 and ctx.adjacent(i - 1, i) else ""
            if _strip_wf(prev, PREPS | IDAFA_HEADS) not in PREPS | IDAFA_HEADS:
                ctx.set_case(t, "nom")


_COURT_ADJ = _norm_set("الكلية الجزئية الابتدائية الاستئنافية العليا الدستورية الاقتصادية")
_COURT_HEADS = frozenset(p + "محكمة" for p in _PREFIXES)


def _court_adjective(ctx: Ctx) -> None:
    """`بِمَحْكَمَةِ ابُو حِمْصَ الْكُلِّيَّةُ`: the court adjective agrees with `محكمة`, not with the
    place name between them."""
    toks = ctx.toks
    for i, t in enumerate(toks):
        if t.nb not in _COURT_ADJ:
            continue
        for back in (1, 2, 3):
            j = i - back
            if j < 0 or not all(ctx.adjacent(k, k + 1) for k in range(j, i)):
                break
            if toks[j].nb in _COURT_HEADS:
                case = ctx.case_of(toks[j])[0]
                if case is not None:
                    ctx.set_case(t, case)
                break


def _mushar(ctx: Ctx) -> None:
    """`مُشَارِ إِلَيْهِ` -> `مُشَارٍ إِلَيْهِ`: the indefinite manqus participle takes tanween."""
    toks = ctx.toks
    for i, t in enumerate(toks[:-1]):
        if t.nb == "مشار" and ctx.adjacent(i, i + 1) and toks[i + 1].nb.startswith("الي"):
            n = len(t.bare)
            m = ctx.marks(t, n - 1)
            after_figure = bool(re.search(rf"[{DIGITS}ق]\s*[-–/)]*\s*$", ctx.s[: t.start]))
            if after_figure:  # citation line: `الطعن رقم 5 لسنة 9 ق ... مُشَارٌ إليه`
                ctx.setm(t, n - 1, DT)
            elif K in m:
                ctx.setm(t, n - 1, KT)
            elif D in m:
                ctx.setm(t, n - 1, DT)


RULES: list[Callable[[Ctx], None]] = [
    _article_alef,
    _lexicon,
    _hamza_below,
    _heading,
    _mahall,
    _alif_maqsura_preps,
    _wafa,
    _mudda3a,
    _min_sukun,
    _ba_anna,
    _dhidd,
    _amr_taqdir,
    _passive_verbs,
    _currency,
    _number_noun_idafa,
    _prep_governs_genitive,
    _fem_adjective,
    _conj_genitive,
    _idafa_tanween,
    _alzamahu,
    _ghayr_tanween,
    _anna,
    _mudaf_heads,
    _qalam_kuttab,
    _mushar,
    _nisba_case,
    _titles_and_lists,
    _court_adjective,
]


def apply_fixes(stripped: str, spans, raw: str, oracle=None) -> tuple[str, int]:
    """Apply all corrections to the engine output `raw` (aligned letter-for-letter with
    `stripped`; `spans` = Arabic-word matches in `stripped`). Returns (text, mark edits)."""
    pairs = split_pairs(raw, canon=False)
    if len(pairs) != len(stripped):
        return raw, 0
    ctx = Ctx(stripped, spans, pairs, oracle)
    for rule in RULES:
        rule(ctx)
    if not ctx.changes:
        return raw, 0
    return "".join(b + m for b, m in ctx.pairs), ctx.changes


__all__ = ["apply_fixes", "compose", "lexicon", "load_lexicon", "norm"]
