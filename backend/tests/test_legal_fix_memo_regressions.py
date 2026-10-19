"""Regression tests for the errors the engine made on the owner's legal memo (new vs v1).

Each case is `(engine output, owner gold)`; the rules are general (a lexicon entry, a mark
normalization or a grammatical constraint), not file-specific."""

from __future__ import annotations

import pytest

from app.engine.legal_fix import apply_fixes, load_lexicon
from app.engine.normalize import (
    MARKS,
    WORD_RE,
    fix_alef_marks,
    has_arabic_letters,
    split_pairs,
    strip_marks,
)


def canon(t: str) -> str:
    return "".join(b + m for b, m in split_pairs(t))


def fix(raw: str, left: str = "", right: str = "") -> str:
    s = strip_marks(raw)
    spans = [m for m in WORD_RE.finditer(s) if has_arabic_letters(m.group(0))]
    out, _ = apply_fixes(s, spans, raw, None, left, right)
    assert strip_marks(out) == s  # marks only, never a base letter
    return out


def check(raw: str, gold: str) -> None:
    assert canon(fix(raw)) == canon(gold)


# ---- lexicon entries ---------------------------------------------------------------------------
LEXICON_CASES = [
    ("وَفْقًا لِتِلْكِ الْقَوَاعِدِ", "وَفْقًا لِتِلْكَ الْقَوَاعِدِ"),
    ("فِي تِلْكِ الْحَالَةِ", "فِي تِلْكَ الْحَالَةِ"),
    # ولاية is not و + ل + اية (the `أية` entry must not swallow it)
    ("تَتَعَلَّقُ بِوَلِاَيَّةَ الْمَحْكَمَةِ", "تَتَعَلَّقُ بِوِلَايَةِ الْمَحْكَمَةِ"),
    ("وَلِاَيَّةَ", "وِلَايَةَ"),
    ("لَا عِلاَقَةٍ لَهُ", "لَا عَلَاقَةٍ لَهُ"),
    ("عِلاَقَةٍ مَنْطِقِيَّةٍ", "عَلَاقَةٍ مَنْطِقِيَّةٍ"),
    # the genuine `أية` entry still works
    ("فِي اَيَّةِ حَالَةٍ", "فِي اَيَّةِ حَالَةٍ"),
]


@pytest.mark.parametrize(("raw", "gold"), LEXICON_CASES)
def test_lexicon(raw: str, gold: str) -> None:
    check(raw, gold)


def test_lam_prefix_flag_in_lexicon() -> None:
    lex = load_lexicon()
    assert lex.words["ولاية"].entry.tpl == "وِلَايَة" and lex.words["ولاية"].prefix == ""
    assert lex.words["واية"].entry.tpl.startswith("اَيَّ")  # و + أية is still read as a prefix
    assert "لاية" not in lex.words and "ولايه" not in lex.words  # no ل-prefixed reading
    assert lex.words["بولاية"].prefix == "ب"


# ---- alef marks: the mark sits on the lam, never on the alef -------------------------------------
ALEF_CASES = [
    ("لَاَبَسَتْهَا", "لَابَسَتْهَا"),  # doubled fatha
    ("لاَ", "لَا"),
    ("وَلاَ", "وَلَا"),
    ("لاَبَسَتْهَا", "لَابَسَتْهَا"),
    ("لِيَكُونَ الاِجْمَالِ", "لِيَكُونَ الِاجْمَالِ"),  # kasra on the alef
    ("لِيَكُونَ الْاِجْمَالِ", "لِيَكُونَ الِاجْمَالِ"),  # sukun on the lam, kasra on the alef
    ("بِالاِعْتِدَالِ", "بِالِاعْتِدَالِ"),
    ("عَمَلاً", "عَمَلًا"),  # tanween fatha on the alef
    ("عَمَلًاً", "عَمَلًا"),  # doubled tanween
    ("الَّذِي", "الَّذِي"),
    ("كَانَ", "كَانَ"),
]


@pytest.mark.parametrize(("raw", "gold"), ALEF_CASES)
def test_alef_marks(raw: str, gold: str) -> None:
    check(raw, gold)
    assert canon(fix_alef_marks(raw)) == canon(gold)


def test_alef_marks_never_in_output() -> None:
    import re

    text = "لَاَبَسَتْهَا لاَ الاِجْمَالِ الْاِمْتِحَانِ وَلاَ عَمَلاً بِالاِعْتِدَالِ"
    for out in (fix(text), fix_alef_marks(text)):
        assert not re.search(f"ا[{MARKS}]", out), out  # no mark on a mid-word alef
        assert "لاَ" not in out and "الاِ" not in out and "لَاَ" not in out


def test_alef_marks_leave_a_different_vowel_alone() -> None:
    # a bare alef standing for a hamza (`فَاِنَّ`) keeps its own vowel
    assert fix_alef_marks("فَاِنَّ") == "فَاِنَّ"
    assert fix_alef_marks("اِسْتَقَرَّ") == "اِسْتَقَرَّ"  # the initial alef is never touched


# ---- فعالى plural, passive participles ----------------------------------------------------------
GRAMMAR_CASES = [
    ("فِي الدَّعَاوِى مَعْلُومَةِ", "فِي الدَّعَاوَى مَعْلُومَةِ"),
    ("وَالدَّعَاوِى", "وَالدَّعَاوَى"),
    ("الطَّحَاوِى", "الطَّحَاوِى"),  # a surname, not the plural
    ("الدَّفْعُ الْمُبْدِى مِنَ الْمُدَّعِي", "الدَّفْعُ الْمُبْدَى مِنَ الْمُدَّعِي"),
    ("الدُّفُوعِ الْمُبْدِى", "الدُّفُوعِ الْمُبْدَى"),
    ("الْمُبْدِي لِرَأْيِهِ", "الْمُبْدِي لِرَأْيِهِ"),  # active: left alone
    ("الْعَقَارِ الْمُتَنَازِعِ عَلَيْهِ", "الْعَقَارِ الْمُتَنَازَعِ عَلَيْهِ"),
    ("الْحَقِّ الْمُتَنَازِعِ فِيهِ", "الْحَقِّ الْمُتَنَازَعِ فِيهِ"),
    # masdar after a preposition / with an attached preposition
    ("بِتُوَافِرِ الشُّرُوطِ", "بِتَوَافُرِ الشُّرُوطِ"),
    ("مِنْ تُوَافِرِ الشَّرْطِ", "مِنْ تَوَافُرِ الشَّرْطِ"),
    ("وَقَدْ تَوَافَرَ الشَّرْطُ", "وَقَدْ تَوَافَرَ الشَّرْطُ"),  # past verb: untouched
]


@pytest.mark.parametrize(("raw", "gold"), GRAMMAR_CASES)
def test_grammar(raw: str, gold: str) -> None:
    check(raw, gold)


# ---- voice: a following subject makes the verb active -----------------------------------------
VOICE_CASES = [
    ("وَمَا يُفَصَّلُ الْمَحْكَمَةُ فِيهِ", "وَمَا يَفْصِلُ الْمَحْكَمَةُ فِيهِ"),
    ("أَنْ تُحْكَمَ الْمَحْكَمَةُ فِي الدَّعْوَى", "أَنْ تَحْكُمَ الْمَحْكَمَةُ فِي الدَّعْوَى"),
    ("حَيْثُ تُنْظَرُ الْمَحْكَمَةُ الطَّعْنَ", "حَيْثُ تَنْظُرُ الْمَحْكَمَةُ الطَّعْنَ"),
    ("وَتُلْزَمُ الْمَحْكَمَةُ الْمُدَّعِي بِالْمَصْرُوفَاتِ", "وَتُلْزِمُ الْمَحْكَمَةُ الْمُدَّعِي بِالْمَصْرُوفَاتِ"),
    ("وَتُلْزِمُ الْمَحْكَمَةَ الْمُدَّعِي", "وَتُلْزِمُ الْمَحْكَمَةُ الْمُدَّعِي"),  # subject: nominative
    ("لَمْ يَقْضِ بِشَيْءٍ", "لَمْ يُقْضَ بِشَيْءٍ"),
    ("وَلَمْ يَقْضِ فِيهِ", "وَلَمْ يُقْضَ فِيهِ"),
    ("لَمْ يَقْضِ الْقَاضِي بِشَيْءٍ", "لَمْ يَقْضِ الْقَاضِي بِشَيْءٍ"),
    ("تُنْظَرُ الدَّعْوَى", "تُنْظَرُ الدَّعْوَى"),  # no court subject: stays passive
]


@pytest.mark.parametrize(("raw", "gold"), VOICE_CASES)
def test_voice(raw: str, gold: str) -> None:
    check(raw, gold)


# ---- case endings -----------------------------------------------------------------------------
CASE_CASES = [
    # indefinite head without a complement takes tanween
    ("حَكَمَتْ بِمَبْلَغِ وَقَدْرُهُ أَلْفُ جُنَيْهٍ", "حَكَمَتْ بِمَبْلَغٍ وَقَدْرُهُ أَلْفُ جُنَيْهٍ"),
    ("بِمَبْلَغِ قَدْرُهُ 500 جُنَيْهٍ", "بِمَبْلَغٍ قَدْرُهُ 500 جُنَيْهٍ"),
    ("وَمَبْلَغُ صُنْدُوقِ خَدَمَاتٍ", "وَمَبْلَغُ صُنْدُوقِ خَدَمَاتٍ"),  # idafa: untouched
    ("وَمَبْلَغُ صُنْدُوقِ.", "وَمَبْلَغُ صُنْدُوقٍ."),
    ("عَلَى أَسَاسِ مِنَ الْعَدْلِ", "عَلَى أَسَاسٍ مِنَ الْعَدْلِ"),
    ("عَلَى هَذَا الْأَسَاسِ .", "عَلَى هَذَا الْأَسَاسِ ."),  # definite
    # signature line: mubtada
    ("نَائِبَ رَئِيسِ هَيْئَةِ قَضَايَا الدَّوْلَةِ", "نَائِبُ رَئِيسِ هَيْئَةِ قَضَايَا الدَّوْلَةِ"),
    ("وَتَفَضَّلُوا\nنَائِبَ رَئِيسِ هَيْئَةِ", "وَتَفَضَّلُوا\nنَائِبُ رَئِيسِ هَيْئَةِ"),
    ("بِصِفَتِهِ نَائِبَ رَئِيسِ هَيْئَةِ", "بِصِفَتِهِ نَائِبَ رَئِيسِ هَيْئَةِ"),  # mid-line
    # a quotation that opens a clause begins with a mubtada
    ('"الرُّسُومَ الْمُسْتَحَقَّةَ" وَاجِبَةٌ', '"الرُّسُومُ الْمُسْتَحَقَّةُ" وَاجِبَةٌ'),
    ('قَضَى بِالْآتِي: "الرُّسُومَ الْمُسْتَحَقَّةَ" ', 'قَضَى بِالْآتِي: "الرُّسُومُ الْمُسْتَحَقَّةُ" '),
    # ... but after أنَّ the first word is its noun (accusative), even across a colon
    ("وَأَنَّ : الْمَادَّةُ 5 تَنُصُّ", "وَأَنَّ : الْمَادَّةَ 5 تَنُصُّ"),
    ('عَلَى أَنْ: "الْمَادَّةُ 5 تَنُصُّ', 'عَلَى أَنَّ: "الْمَادَّةَ 5 تَنُصُّ'),
    ('عَلَى أَنَّ: "الْمَادَّةُ 5 تَنُصُّ', 'عَلَى أَنَّ: "الْمَادَّةَ 5 تَنُصُّ'),
    ("أَنَّ الْمُفَاوَضَاتِ مُسْتَمِرَّةٌ", "أَنَّ الْمُفَاوَضَاتِ مُسْتَمِرَّةٌ"),  # ـات: kasra is right
    # a court after a preposition or as the complement of a relational noun is genitive
    ("وَرَدَ بِمَحْكَمَةُ النَّقْضِ", "وَرَدَ بِمَحْكَمَةِ النَّقْضِ"),
    ("وَأَمَامَ لِمَحْكَمَةُ", "وَأَمَامَ لِمَحْكَمَةِ"),
    ("رَئِيسُ مَحْكَمَةُ النَّقْضِ", "رَئِيسُ مَحْكَمَةِ النَّقْضِ"),
    ("رَئِيسُ الْمَحْكَمَةُ", "رَئِيسُ الْمَحْكَمَةِ"),
    ("قَلَمُ مَحْكَمَةُ", "قَلَمُ مَحْكَمَةِ"),
    ("مَحْكَمَةُ النَّقْضِ الْمِصْرِيَّةُ", "مَحْكَمَةُ النَّقْضِ الْمِصْرِيَّةُ"),  # a mubtada: kept
]


@pytest.mark.parametrize(("raw", "gold"), CASE_CASES)
def test_case_endings(raw: str, gold: str) -> None:
    check(raw, gold)


# ---- pipeline: the alef normalization applies to every real engine, not to the mock -------------
def test_pipeline_normalizes_alef_marks(tmp_path) -> None:
    from app.core.database import connect
    from app.engine.base import Engine
    from app.engine.pipeline import TashkeelPipeline
    from app.main import create_app

    class Fixed(Engine):
        name, cache_tag = "fixed", "fixed"

        def diacritize(self, words, lookup=None):
            table = {"لابستها": "لَاَبَسَتْهَا", "الامتحان": "الْاِمْتِحَانِ", "لا": "لاَ"}
            return [table.get(w, w) for w in words]

    create_app(tmp_path)
    conn = connect(tmp_path / "mizaj.db")
    try:
        pipe = TashkeelPipeline(Fixed(), use_cache=False)
        out = pipe.process_chunk(conn, "لا لابستها الامتحان").text
        assert canon(out) == canon("لَا لَابَسَتْهَا الِامْتِحَانِ")
    finally:
        conn.close()
