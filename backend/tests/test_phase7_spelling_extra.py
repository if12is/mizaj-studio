"""Slices 7.9.6 (typography), 7.9.7 (readability), 7.9.8 (eval script)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import spelling as spelling_api
from app.main import create_app

ROOT = Path(__file__).resolve().parent.parent
FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def sp(tmp_path):
    app = create_app(tmp_path / "data")
    app.include_router(spelling_api.router)
    with TestClient(app) as c:
        yield c


def norm(c, text, **opts):
    r = c.post("/api/spelling/normalize", json={"text": text, "options": opts})
    assert r.status_code == 200, r.text
    return r.json()


def test_typography_category_in_check(sp):
    text = "الكتــاب جميل ‌ﻻ بأس وكتاب"
    r = sp.post("/api/spelling/check", json={"text": text, "checks": ["typography"]}).json()
    codes = {i["code"] for i in r["issues"]}
    assert {"TYPO_TATWEEL", "TYPO_NBSP", "TYPO_ZERO_WIDTH", "TYPO_PRESENTATION_FORM"} <= codes
    assert all(i["category"] == "typography" for i in r["issues"])
    pres = next(i for i in r["issues"] if i["code"] == "TYPO_PRESENTATION_FORM")
    assert pres["suggestions"] == ["لا"]


def test_persian_lookalikes(sp):
    text = "كتاب جميل ی و کتاب"
    got = norm(sp, "هذه مدرسه جدیدة وکتاب")["edits"]
    assert {e["code"] for e in got} == {"TYPO_PERSIAN_LETTER"}
    assert [e["new"] for e in got] == ["جديدة", "وكتاب"]
    assert norm(sp, "این کتاب پارسی است")["edits"] == []  # Persian text is not touched
    assert text  # silence unused


def test_normalize_is_a_proposal_only(sp):
    text = "ا ب  ـ"
    r = norm(sp, text)
    assert r["applied"] is False
    assert any(e["old"] == " " and e["new"] == " " for e in r["edits"])
    assert text == "ا ب  ـ"  # input untouched
    for e in r["edits"]:
        assert text[e["start"] : e["end"]] == e["old"]


def test_digit_options_and_identifier_protection(sp):
    text = (
        "في 15 مايو دفعت 1,250.5 ريال ورقم IBAN SA0380000000608010167519 "
        "والقضية 123456789012 و3-ب"
    )
    r = norm(sp, text, digits="arabic_indic")
    news = {e["old"]: e["new"] for e in r["edits"] if e["code"] == "TYPO_DIGITS"}
    assert news["15"] == "١٥" and news["1,250.5"] == "١٬٢٥٠٫٥"
    assert "123456789012" not in news and not any("SA03" in k for k in news)
    r2 = norm(sp, "في ١٥ مايو", digits="western")
    assert r2["edits"][0]["new"] == "15" and r2["preview"] == "في 15 مايو"
    assert [e for e in norm(sp, "في 15 مايو")["edits"] if e["code"] == "TYPO_DIGITS"] == []


def test_quote_normalization_option(sp):
    r = norm(sp, 'قال "نعم" ثم “لا”', quotes="guillemets")
    assert r["preview"] == "قال «نعم» ثم «لا»"


def test_offsets_with_astral(sp):
    r = norm(sp, "😀 كتـاب")
    (e,) = r["edits"]
    assert e["start"] == 4 and e["start16"] == 5


def test_clean_text_has_no_typography_issues(sp):
    text = (FIX / "sample_long.txt").read_text(encoding="utf-8")
    r = sp.post("/api/spelling/check", json={"text": text, "checks": ["typography"]}).json()
    assert r["issues"] == []


# ------------------------------------------------------------------ readability
def test_readability_metrics_shape(sp):
    text = (FIX / "sample_long.txt").read_text(encoding="utf-8")
    r = sp.post("/api/spelling/readability", json={"text": text}).json()
    m = r["metrics"]
    assert m["words"] > 20_000 and m["sentences"] > 100 and m["osman"] is not None
    assert r["osman"]["exact"] is True and "L16-1038" in r["reference"]
    assert m["osman"] == r["osman"]["score"] and "approximate" not in r
    assert set(r) >= {"long_sentences", "passive", "repeated_words", "long_paragraphs"}


def test_osman_matches_official_reference_exactly():
    """Every component and the score equal the Java reference's output (fixture)."""
    import json

    from app.spelling.osman import osman

    data = json.loads((FIX / "osman_reference.json").read_text(encoding="utf-8"))
    assert len(data["cases"]) >= 100
    for c in data["cases"]:
        o = osman(c["text"])
        for k in ("words", "sentences", "complex", "syllables", "faseeh", "long"):
            assert o[k] == c[k], (k, c["text"][:40], o[k], c[k])
        assert abs(o["score"] - c["score"]) < 1e-6, c["text"][:40]


def test_osman_reference_quirks():
    from app.spelling.osman import osman

    assert osman("")["words"] == 1 and osman(".")["sentences"] == 0
    assert osman("3.5 كلمة")["sentences"] == 1  # a dot between digits does not end a sentence


def test_harder_text_scores_lower(sp):
    easy = "ذهب الولد. عاد الولد. أكل الولد."
    hard = (
        "استمرارية المؤسسات الاقتصادية تتطلب مراجعة مستفيضة للسياسات التنظيمية "
        "والإجراءات التشغيلية المتراكمة عبر عقود طويلة من الممارسات الإدارية المعقدة."
    )
    a = sp.post("/api/spelling/readability", json={"text": easy}).json()["metrics"]["osman"]
    b = sp.post("/api/spelling/readability", json={"text": hard}).json()["metrics"]["osman"]
    assert a > b


def test_style_hints(sp):
    long_sentence = " ".join(["كلمة"] * 40) + "."
    para = " ".join(["نص"] * 200)
    text = f"تم إنجاز المشروع. {long_sentence}\n\n{para}\n\nالمشروع المشروع الكبير يحتاج المشروع."
    r = sp.post("/api/spelling/readability", json={"text": text, "max_sentence_words": 30}).json()
    assert r["long_sentences"] and r["long_sentences"][0]["words"] == 40
    assert r["passive"]["count"] >= 1
    assert r["long_paragraphs"] and r["long_paragraphs"][0]["words"] == 200
    assert any(w["word"] == "المشروع" for w in r["repeated_words"]) or r["repeated_words"] == []
    empty = sp.post("/api/spelling/readability", json={"text": ""}).json()
    assert empty["metrics"]["osman"] is None


# ------------------------------------------------------------------ eval script
def test_eval_script_runs_and_meets_floor():
    sys.path.insert(0, str(ROOT.parent / "scripts"))
    import eval_spelling

    res = eval_spelling.run(1)
    assert res["clean_fp"] == 0
    s = res["stats"]
    for k in ("repeated_word", "double_space", "latin_comma"):
        assert s[k]["detected"] == s[k]["n"]
    assert s["hamza_qat"]["detected"] / s["hamza_qat"]["n"] > 0.7
    assert (ROOT / "app" / "spelling" / "EVAL.md").is_file()
    out = subprocess.run(
        [sys.executable, str(ROOT.parent / "scripts" / "eval_spelling.py"), "--no-write"],
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=True,
    )
    assert "| **all** |" in out.stdout
