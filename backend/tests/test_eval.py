import json
from pathlib import Path

import pytest

from eval.corpus import GOLD_DIR, diacritized_ratio, load_corpus, load_gold
from eval.metrics import compute, words
from eval.run_eval import check_baseline, evaluate, to_markdown

BASELINE = json.loads((Path(GOLD_DIR).parent / "baseline.json").read_text(encoding="utf-8"))


def m(gold, pred):
    return compute([gold], [pred])


# ---------- metric functions: hand-computed cases ----------
def test_der_wer_with_and_without_case_ending():
    r = m("كَتَبَ", "كَتَبُ")  # only the final letter's vowel is wrong
    w = r["with_case_ending"]["all"]
    assert (w["letters"], w["letter_errors"]) == (3, 1)
    assert w["der"] == pytest.approx(33.333, abs=0.001) and w["wer"] == 100.0
    assert w["final_der"] == 100.0 and w["internal_der"] == 0.0
    wo = r["without_case_ending"]["all"]
    assert (wo["letters"], wo["letter_errors"]) == (2, 0)
    assert wo["der"] == 0.0 and wo["wer"] == 0.0


def test_perfect_prediction_is_zero():
    t = "الشَّمْسُ تُشْرِقُ مِنَ الشَّرْقِ"
    for case in ("with_case_ending", "without_case_ending"):
        for scope in ("all", "gold_only"):
            assert m(t, t)[case][scope]["der"] == 0.0
            assert m(t, t)[case][scope]["wer"] == 0.0


def test_scopes_all_vs_gold_only():
    # gold: ك kasra, ت fatha, ا (none), ب tanween. Prediction adds a fatha on the alef.
    r = m("كِتَابٌ", "كِتَاَبٌ")
    a, g = r["with_case_ending"]["all"], r["with_case_ending"]["gold_only"]
    assert (a["letters"], a["letter_errors"]) == (4, 1) and a["der"] == 25.0
    assert (g["letters"], g["letter_errors"]) == (3, 0) and g["der"] == 0.0
    # a MISSING diacritic is an error in both scopes
    r = m("كِتَابٌ", "كتابٌ")
    assert r["with_case_ending"]["gold_only"]["letter_errors"] == 2
    assert r["with_case_ending"]["all"]["letter_errors"] == 2


def test_wer_counts_each_word_once():
    r = m("ذَهَبَ الْوَلَدُ", "ذَهَبَ الْوَلَدَ")  # 1 of 2 words wrong (final letter)
    w = r["with_case_ending"]["all"]
    assert w["words"] == 2 and w["word_errors"] == 1 and w["wer"] == 50.0
    assert w["letter_errors"] == 1


def test_shadda_and_internal_vowel_breakdown():
    r = m("مُعَلِّمٌ", "مُعَلِمٌ")  # shadda dropped; vowels equal
    w = r["with_case_ending"]["all"]
    assert w["shadda_error"] == 100.0
    assert w["letter_errors"] == 1  # the lam: kasra+shadda vs kasra
    assert w["internal_der"] == 0.0  # vowel part of the lam is the same
    r = m("مُعَلِّمٌ", "مُعَلَّمٌ")  # shadda ok, vowel wrong
    w = r["with_case_ending"]["all"]
    assert w["shadda_error"] == 0.0 and w["internal_der"] == pytest.approx(33.333, abs=0.001)


def test_tanween_fatha_alef_normalised_and_alignment():
    gold, alt = "كِتَابًا", "كِتَابا\u064b"  # tanween on ب (standard) vs on the final alef
    assert m(gold, alt)["with_case_ending"]["all"]["der"] == 0.0
    assert words(alt)[0][-2][1] == "\u064b" and words(alt)[0][-1][1] == ""
    r = m("كتاب", "كتب")  # base text differs -> not scored, reported
    assert r["unaligned_sentences"] == 1 and r["with_case_ending"]["all"]["letters"] == 0
    assert r["with_case_ending"]["all"]["der"] is None


def test_non_arabic_ignored_and_marks_order_irrelevant():
    r = m("شَدَّ iPhone 16", "شَدَّ iPhone 16")
    assert r["with_case_ending"]["all"]["letters"] == 2
    # shadda+fatha and fatha+shadda are the same canonical diacritic
    assert (
        m("ش\u064eد\u064e\u0651", "ش\u064eد\u0651\u064e")["with_case_ending"]["all"]["der"] == 0.0
    )


# ---------- gold set sanity ----------
def test_gold_set_is_fully_diacritized_and_scripture_free():
    items = load_gold()
    assert len(items) >= 150
    assert {c for c, _ in items} == {"general", "legal", "letters", "news"}
    for _cat, line in items:
        assert diacritized_ratio(line) == 1.0, line
        assert not any(c in line for c in "﴿﴾ۖۗۘۙۚۛۜ"), line  # no Quran markers
        assert not any("a" <= c.lower() <= "z" for c in line), line
    assert any("يَلْتَزِمُ الطَّرَفُ الْأَوَّلُ بِتَسْلِيمِ الْعَيْنِ الْمُؤَجَّرَةِ" in s for _, s in items)
    assert (Path(GOLD_DIR) / "SOURCES.md").exists()


def test_external_corpus_loader(tmp_path):
    f = tmp_path / "sub" / "book.txt"
    f.parent.mkdir()
    f.write_text("ذَهَبَ الْوَلَدُ إِلَى الْمَدْرَسَةِ ـــ\nهذا سطر بلا تشكيل نهائيا\nabc\n", encoding="utf-8")
    items = load_corpus(tmp_path, min_ratio=0.8)
    assert len(items) == 1 and "ـ" not in items[0][1] and items[0][0] == "book"
    assert len(load_corpus(f, max_lines=1, min_ratio=0.0)) == 1


# ---------- harness (mock, fast) ----------
def test_harness_mock_matches_baseline_and_reports(monkeypatch):
    monkeypatch.setenv("MIZAJ_ENGINE_MODE", "mock")
    res = evaluate(["mock"], load_gold(), progress=False)
    cur, base = res["engines"]["mock"], BASELINE["engines"]["mock"]
    for case in ("with_case_ending", "without_case_ending"):
        for scope in ("all", "gold_only"):
            assert cur[case][scope]["der"] == pytest.approx(base[case][scope]["der"], abs=1e-6)
            assert cur[case][scope]["wer"] == pytest.approx(base[case][scope]["wer"], abs=1e-6)
    assert cur["unaligned_sentences"] == 0
    assert set(cur["by_category"]) == {"general", "legal", "letters", "news"}
    md = to_markdown(res)
    assert "| mock | all letters |" in md and "By category" in md
    json.dumps(res, ensure_ascii=False)  # serialisable
    assert check_baseline(res, BASELINE, 0.3) == []


def test_check_baseline_detects_regression():
    base = json.loads(json.dumps(BASELINE))
    worse = json.loads(json.dumps(BASELINE))
    worse["engines"]["fast"]["with_case_ending"]["all"]["der"] += 0.5
    assert check_baseline(worse, base, 0.3) and not check_baseline(worse, base, 0.6)
    assert check_baseline(base, base, 0.3) == []
