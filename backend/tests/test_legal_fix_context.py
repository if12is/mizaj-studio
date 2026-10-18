"""Chunk-boundary context for the grammar rules, the splitter particle guard, lexical gaps."""

from __future__ import annotations

from app.engine.legal_fix import apply_fixes
from app.engine.normalize import WORD_RE, has_arabic_letters, split_pairs, strip_marks
from app.engine.splitter import ArabicSentenceSplitter


def canon(t: str) -> str:
    return "".join(b + m for b, m in split_pairs(t))


def fix(raw: str, left: str = "", right: str = "") -> str:
    s = strip_marks(raw)
    spans = [m for m in WORD_RE.finditer(s) if has_arabic_letters(m.group(0))]
    return apply_fixes(s, spans, raw, None, left, right)[0]


def test_left_context_reaches_across_the_chunk_boundary() -> None:
    # `بِأَنْ` / `عَنْ` + article in the NEXT chunk, `رَقْمٌ` after a genitive in the previous one
    assert canon(fix("رَقْمٌ 5 لِسَنَةِ 2020", left="في الدعوى ")) == canon("رَقْمِ 5 لِسَنَةِ 2020")
    assert canon(fix("عَنْ ", right="الدعوى ")).startswith("عَنِ")
    # context is never returned
    assert strip_marks(fix("رَقْمٌ 5", left="في الدعوى ", right=" والباقي")) == "رقم 5"


def test_splitter_never_ends_a_chunk_after_a_particle() -> None:
    text = " ".join(["كلمة"] * 20 + ["إلى", "قلم", "الكتاب"] + ["كلمة"] * 20)
    sp = ArabicSentenceSplitter(max_chars=len(" ".join(["كلمة"] * 20 + ["إلى"])) + 1)
    chunks = sp.split(text)
    assert "".join(c.text for c in chunks) == text
    for c in chunks[:-1]:
        assert c.text.rstrip().split(" ")[-1] != "إلى"


def test_lexical_gaps() -> None:
    assert canon(fix("تَخَلَّصَ وَجِيزَهَا")).startswith("تَخْلُصُ")
    assert canon(fix("وَتُؤَوَّلُ حَصِيلَتُهُ")).startswith(canon("وَتَؤُولُ"))
    assert canon(fix("وَقَدْ فَصَّلْتُ أَمْرَ")).split(" ")[1] == canon("فَصَّلَتْ")
    assert canon(fix("وَقَدْ أَنَا فَصَّلْتُ")).endswith(canon("فَصَّلْتُ"))  # first person kept
    assert canon(fix("شَخْصِيَّةٌ وَمُبَاشَرَةٌ")) == canon("شَخْصِيَّةٌ وَمُبَاشِرَةٌ")
    assert canon(fix("مُؤَكَّدًا الْحَقِيقَةَ")).startswith(canon("مُؤَكِّدًا"))
    assert canon(fix("لِوَزَارَةِ الْعَدْلِ")) == canon("لِوِزَارَةِ الْعَدْلِ")
    assert canon(fix("مَا يُسْتَحَقُّ عَنْهَا")) == canon("مَا يَسْتَحِقُّ عَنْهَا")
