"""Grammar / legal-lexicon corrections (engine/legal_fix.py) and the `essential` level.

Inputs are typical neural-engine mistakes; expected outputs are the owner's hand-diacritized
gold (Egyptian State Litigation Authority memo)."""

from __future__ import annotations

import pytest

from app.engine.legal_fix import apply_fixes
from app.engine.normalize import WORD_RE, has_arabic_letters, reduce_level, split_pairs, strip_marks


def canon(t: str) -> str:
    return "".join(b + m for b, m in split_pairs(t))


def fix(raw: str) -> str:
    s = strip_marks(raw)
    spans = [m for m in WORD_RE.finditer(s) if has_arabic_letters(m.group(0))]
    out, _ = apply_fixes(s, spans, raw)
    assert strip_marks(out) == s  # never a base-letter change
    return out


CASES = [
    # number nouns: no tanween before digits, case agrees; سنة
    ("فِي الدَّعْوَى رَقْمٌ 624 لِسُنَةِ 2026", "فِي الدَّعْوَى رَقْمِ 624 لِسَنَةِ 2026"),
    ("بِالْقَانُونِ رَقْمٌ 81 لِسَنَةٍ 1996", "بِالْقَانُونِ رَقْمِ 81 لِسَنَةِ 1996"),
    ("الطَّعْنُ رَقْمٌ 551 لِسْنَّةِ 55 ق", "الطَّعْنُ رَقْمُ 551 لِسَنَةِ 55 ق"),
    ("بِتَارِيخٍ 8 / 2 / 2025", "بِتَارِيخِ 8 / 2 / 2025"),
    # sukun before the article
    ("مِنْ الْمُقَرَّرِ", "مِنَ الْمُقَرَّرِ"),
    ("فَضْلًا عَنْ الدَّعْوَى", "فَضْلًا عَنِ الدَّعْوَى"),
    ("الْعَقْدِ أَوْ الْبَاقِي", "الْعَقْدِ أَوِ الْبَاقِي"),
    ("وَقَدْ الْتَزَمَ", "وَقَدِ الْتَزَمَ"),
    # article alef never carries a vowel
    ("وَاَلَّتِي صَدَرَ", "وَالَّتِي صَدَرَ"),
    # a preposition never governs a nominative noun
    ("إلَى قَلَمِ الْكِتَابِ", "إِلَى قَلَمِ الْكُتَّابِ"),
    # lexicon: legal words
    ("مُحْكَمَةٌ ابُو حِمْصَ الْكُلِّيَّةُ", "مَحْكَمَةُ اَبُو حُمُّص الْكُلِّيَّةُ"),
    ("مُذَكَّرَةٌ بِدِفَاعِ", "مُذَكِّرَةٌ بِدِفَاعِ"),
    ("وَالْمُحَدِّدُ لِنَظَرِهَا جِلْسَةُ 30/7/2026", "وَالْمُحَدَّدُ لِنَظَرِهَا جَلْسَةُ 30/7/2026"),
    ("حَتَّى تَارِيخُ قُفْلِ بَابِ", "حَتَّى تَارِيخِ قَفْلِ بَابِ"),
    # ى / ي typed prepositions and the defendant
    ("نُعِيَتْ عَلِيَّ الدَّعْوَى", "نُعِيَتْ عَلَي الدَّعْوَى"),
    ("لِلْمُدَّعِي عَلَيْهِمَا الثَّانِى", "لِلْمُدَّعَي عَلَيْهِمَا الثَّانِى"),
    ("يَكُونُ الْمُدَّعَى هُوَ", "يَكُونُ الْمُدَّعِى هُوَ"),
    ("وَفَى هَذَا الشَّأْنِ", "وَفِى هَذَا الشَّأْنِ"),
    # أنّ / بأنّ before a quotation
    ("قَضَتْ بِأَنْ:", "قَضَتْ بِأَنَّ:"),
    ("انْهَا أُعْلِنَتْ", "انَّهَا أُعْلِنَتْ"),
    # dual أمرى + genitive complement
    ("امْرِى تَقْدِيرُ الرُّسُومِ", "اَمْرَىْ تَقْدِيرِ الرُّسُومِ"),
    ("أَصْدَرَتْ أَمْرِي تَقْدِيرَ الرُّسُومِ", "أَصْدَرَتْ أَمْرَيْ تَقْدِيرِ الرُّسُومِ"),
    # nisba shadda / case on the written yaa
    ("رَقْمٌ 175 لِسَنَةِ 2025 نِسْبَى", "رَقْمُ 175 لِسَنَةِ 2025 نِسْبِىٌّ"),
    ("مَدَنِى كُلَى", "مَدَنِىّ كُلِّىّ"),
    # tamyiz of a figure
    ("قَدَرَهُ 2000 جَنَيْهٌ", "قَدْرُهُ 2000 جُنَيْهٍ"),
    # idafa: tanween then a definite genitive noun
    ("فِي قَلَمٌ الْمَحْكَمَةِ", "فِي قَلَمُ الْمَحْكَمَةِ"),
    # verb + pronoun + noun + ب
    ("الَّذِي أَلْزَمَهُ الْحُكْمَ بِمَصْرُوفَاتِ", "الَّذِي أَلْزَمَهُ الْحُكْمُ بِمَصْرُوفَاتِ"),
    ("وَيَلْزَمُ بِهَا", "وَيُلْزَمُ بِهَا"),
    # hamza-below always has its kasra
    ("إلَّا إذَا مُنِحَ", "إِلَّا إِذَا مُنِحَ"),
    # ordinals + titles list in apposition to a genitive
    (
        "لِلْمُدَّعِي عَلَيْهِمَا الثَّانِى وَالثَّالِثُ ( السَّيِّدُ / رَئِيسُ وَحْدَةِ الْمُطَالَبَةِ )",
        "لِلْمُدَّعَي عَلَيْهِمَا الثَّانِى وَالثَّالِثِ ( السَّيِّدِ / رَئِيسِ وَحْدَةِ الْمُطَالَبَةِ )",
    ),
    # غير + indefinite genitive
    ("غَيْرَ مَقْبُولِ", "غَيْرَ مَقْبُولٍ"),
]


@pytest.mark.parametrize("raw,expected", CASES)
def test_fix(raw: str, expected: str) -> None:
    assert canon(fix(raw)) == canon(expected)


def test_idempotent_and_base_letters_untouched() -> None:
    for raw, _ in CASES:
        once = fix(raw)
        assert fix(once) == once or strip_marks(fix(once)) == strip_marks(raw)


def test_essential_level() -> None:
    full = "كَتَبَ الْوَلَدُ دَرْسًا وَأَنَّ الْمُدَّعِيَ مُؤَكَّدًا"
    # last-letter marks + fathatan before a final alef + every shadda with its vowel
    assert canon(reduce_level(full, "essential")) == canon("كتبَ الولدُ درسًا وأنَّ المدَّعيَ مؤكَّدًا")
    assert canon(reduce_level(full, "irab_only")) == canon("كتبَ الولدُ درسًا وأنَّ المدعيَ مؤكدًا")
    assert canon(reduce_level("مُحَمَّدٌ", "essential")) == canon("محمَّدٌ")
    assert canon(reduce_level("سَنَوِيًّا", "essential")) == canon("سنويًّا")
    assert canon(reduce_level("الْعَامِّ", "essential")) == canon("العامِّ")
    assert canon(reduce_level("لَا يَجُوزُ", "essential")) == canon("لا يجوزُ")
    assert canon(reduce_level("abc كِتَابٌ 12", "essential")) == canon("abc كتابٌ 12")
