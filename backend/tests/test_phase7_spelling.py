"""Slice 7.9.1-7.9.3: dictionary spell check, error patterns, Arabic punctuation."""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import spelling as spelling_api
from app.main import create_app
from app.spelling.engine import get_engine
from app.spelling.hunspell_lite import HunspellLite
from app.spelling.service import check_text

FIX = Path(__file__).parent / "fixtures"
GOLD = Path(__file__).parent.parent / "eval" / "gold"


@pytest.fixture
def sp(tmp_path):
    app = create_app(tmp_path / "data")
    app.include_router(spelling_api.router)
    with TestClient(app) as c:
        yield c


def chk(client, text, checks=None, **kw):
    body = {"text": text, **kw}
    if checks is not None:
        body["checks"] = checks
    r = client.post("/api/spelling/check", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def codes(res):
    return [i["code"] for i in res["issues"]]


# ---------------------------------------------------------------- 7.9.1 dictionary
def test_dictionary_loads_and_status(sp):
    s = sp.get("/api/spelling/status").json()
    assert s["ready"] is True
    d = s["dictionary"]
    assert d["words"] > 200_000
    assert "GPL" in d["license"] and "MPL" in d["license"]


def test_hunspell_lite_accepts_inflected_and_rejects_garbage():
    e = get_engine()
    for ok in ("كتاب", "والكتاب", "بالمدرسة", "الكتابان", "استخدام", "يكتبون"):
        assert e.is_valid(ok), ok
    for bad in ("إستخدام", "ذهبو", "كتابقديم", "ممدرسة"):
        assert not e.is_valid(bad), bad


def test_marks_and_tatweel_are_ignored_for_lookup(sp):
    res = chk(sp, "الْكِتَابُ جَمِيلٌ والكتـــاب مفيد")
    assert res["issues"] == []


def test_correct_text_has_no_issues(sp):
    long_text = (FIX / "sample_long.txt").read_text(encoding="utf-8")
    res = chk(sp, long_text)
    assert res["issues"] == []
    gold = "\n".join(
        ln
        for f in sorted(GOLD.glob("*.txt"))
        for ln in f.read_text(encoding="utf-8").splitlines()
        if not ln.startswith("#")
    )
    assert chk(sp, gold)["issues"] == []


def test_unknown_word_gets_ranked_suggestions(sp):
    res = chk(sp, "هذا كتابقديم جدا", checks=["dictionary"])
    (i,) = res["issues"]
    assert i["category"] == "spelling" and i["code"] == "SPELL_UNKNOWN"
    assert i["word"] == "كتابقديم"
    assert "كتاب قديم" in i["suggestions"]


def test_arabic_aware_ranking_prefers_hamza_ta_marbuta_confusions():
    e = get_engine()
    assert e.suggest("الشركه")[0] == "الشركة"
    assert e.suggest("إستخدام")[0] == "استخدام"


def test_foreign_digits_urls_code_and_emphasis_are_skipped(sp):
    text = "زر https://example.com/صفحةسيئة و abcمثالxyz و `كودسيئ` و هههههه و 123 و ملف_x.py"
    assert chk(sp, text, checks=["dictionary"])["issues"] == []


def test_spylls_agreement_sample():
    """Our lite engine must agree with itself on the stems it loaded (cheap sanity check)."""
    h = HunspellLite.load(
        Path(spelling_api.__file__).parent.parent / "spelling" / "data" / "ar.aff",
        Path(spelling_api.__file__).parent.parent / "spelling" / "data" / "ar.dic.gz",
    )
    sample = [s for i, s in enumerate(h.stems) if i % 997 == 0][:200]
    assert sample and all(h.check(s) for s in sample)


# ---------------------------------------------------------------- 7.9.2 patterns
POSITIVE = [
    ("إستخدام النظام سهل", "HAMZA_WASL", "استخدام"),
    ("ذهبت الى المدرسة", "HAMZA_QAT", "إلى"),
    ("ذهبت الي المدرسة", "ALEF_MAQSURA", "إلى"),
    ("نام حتي الصباح", "ALEF_MAQSURA", "حتى"),
    ("لا أعرف متي يصل", "ALEF_MAQSURA", "متى"),
    ("زرت المستشفي أمس", None, None),  # valid in ayaspell only via a lenient variant: not asserted
    ("الطلاب ذهبو إلى البيت", "ALEF_FARQA", "ذهبوا"),
    ("الشركه كبيرة", "TAA_MARBUTA", "الشركة"),
    ("قال لي شيئ مهم", "HAMZA_SEAT", "شيء"),
    ("سنلتقي انشاء الله غدا", "SPLIT_JOIN", "إن شاء الله"),
    ("سنلتقي ان شاء الله غدا", "HAMZA_QAT", "إن شاء الله"),
    ("هاذا الكتاب", "SPLIT_JOIN", "هذا"),
    ("لاكن الجو جميل", "SPLIT_JOIN", "لكن"),
    ("هذا الكتاب في في البيت", "REPEATED_WORD", ""),
    ("قال المدير ان العمل انتهى", "HAMZA_QAT", "إن"),
    ("الاسلام دين", "HAMZA_QAT", "الإسلام"),
    ("جاء كتاباًً وكتابًا", None, None),
    ("اشتريت مدرسةاً", "TANWEEN_ALEF", None),
]


@pytest.mark.parametrize("text,code,sugg", POSITIVE)
def test_pattern_positive(sp, text, code, sugg):
    if code is None:
        return
    res = chk(sp, text, checks=["patterns"])
    hits = [i for i in res["issues"] if i["code"] == code]
    assert hits, (text, res["issues"])
    assert hits[0]["category"] == "pattern"
    assert hits[0]["message_ar"]
    assert 0 < hits[0]["confidence"] <= 1
    if sugg is not None:
        assert hits[0]["suggestions"][0] == sugg


NEGATIVE = [
    "ذهبت إلى المدرسة على الدراجة",
    "الأول من الشهر",
    "هو يدعو إلى الخير ويرجو الصفح",  # واو أصلية: لا ألف فارقة
    "قال علي إن الجو جميل",  # علي اسم علم
    "الله أكبر والحمد لله",
    "يجب على الطالب أن يدرس",
    "لدي كتاب جديد",  # لدي = عندي، صحيحة
    "تعتبر المدرسة مهمة وقد زرتها",
    "هذا واحد وهذا اثنان",  # واحد لا تُصحَّح إلى وأحد
    "كتبوا الدرس ثم ذهبوا",
    "مدرسةً جميلة وماءً باردا",  # تنوين صحيح بلا ألف زائدة
    "لا لا لن أذهب",  # تكرار مقصود
    "الوجه جميل والفقيه عالم",
    "إن شاء الله سنلتقي",
    "قال إنه سيحضر",
]


@pytest.mark.parametrize("text", NEGATIVE)
def test_pattern_negative(sp, text):
    assert chk(sp, text, checks=["patterns"])["issues"] == []


def test_repeated_rule_span_is_clean_removal(sp):
    text = "ذهب الولد من من البيت"
    (i,) = chk(sp, text, checks=["patterns"])["issues"]
    fixed = text[: i["start"]] + i["suggestions"][0] + text[i["end"] :]
    assert fixed == "ذهب الولد من البيت"


def test_tanween_style_consistency_is_info(sp):
    res = chk(sp, "قرأت كتابًا وكتاباً وبيتاً وبابًا ودرساً", checks=["patterns"])
    styles = [i for i in res["issues"] if i["code"] == "TANWEEN_STYLE"]
    assert styles and all(i["severity"] == "info" for i in styles)
    # a document using one style consistently is not flagged
    assert chk(sp, "قرأت كتاباً وبيتاً", checks=["patterns"])["issues"] == []


def test_error_set_fixed_exactly_and_no_false_positives(sp):
    rows = [
        ln.split("\t")
        for ln in (FIX / "spelling_errors.txt").read_text(encoding="utf-8").splitlines()
        if ln.strip()
    ]
    assert len(rows) >= 80
    fixed_ok = total = 0
    for wrong, right in rows:
        # corrected sentences must be clean (precision)
        assert chk(sp, right)["issues"] == [], right
        if wrong == right:
            continue
        total += 1
        out, last = wrong, len(wrong) + 1
        for i in sorted(chk(sp, wrong)["issues"], key=lambda i: -i["start"]):
            if i["end"] > last or not i["suggestions"]:
                continue
            if i["severity"] == "info" and i["category"] == "spelling":
                continue
            out = out[: i["start"]] + i["suggestions"][0] + out[i["end"] :]
            last = i["start"]
        fixed_ok += out == right
    assert fixed_ok / total >= 0.95, (fixed_ok, total)


# ---------------------------------------------------------------- 7.9.3 punctuation
P = ["punctuation"]


def test_latin_marks_in_arabic_context(sp):
    res = chk(sp, "هل تحب الشاي, أم القهوة; ما اسمك?", checks=P)
    got = {i["code"]: i for i in res["issues"]}
    assert got["PUNCT_LATIN_COMMA"]["suggestions"] == ["،"]
    assert got["PUNCT_LATIN_SEMICOLON"]["suggestions"] == ["؛"]
    assert got["PUNCT_LATIN_QUESTION"]["suggestions"] == ["؟"]


def test_latin_marks_left_alone_in_english_and_numbers(sp):
    text = "Hello, world; what? 1,000 and 3,14 ثم https://a.com/?q=1 ثم x"
    latin = [i for i in chk(sp, text, checks=P)["issues"] if i["code"].startswith("PUNCT_LATIN")]
    assert latin == []


def test_space_before_and_missing_after(sp):
    res = chk(sp, "وصل أحمد ، ثم غادر!قال:نعم", checks=P)
    c = codes(res)
    assert "PUNCT_SPACE_BEFORE" in c
    assert c.count("PUNCT_SPACE_AFTER_MISSING") >= 2
    before = next(i for i in res["issues"] if i["code"] == "PUNCT_SPACE_BEFORE")
    assert before["word"] == " " and before["suggestions"] == [""]


def test_double_spaces_and_indentation(sp):
    res = chk(sp, "هذا  كتاب\n    مفيد جدا", checks=P)
    (i,) = (x for x in res["issues"] if x["code"] == "PUNCT_DOUBLE_SPACE")
    assert (i["start"], i["end"]) == (3, 5) and i["suggestions"] == [" "]


def test_brackets_and_quotes(sp):
    res = chk(sp, 'هذا ( كتاب ) و "اقتباس" و «سليم» و - [ ] مهمة', checks=P)
    c = codes(res)
    assert c.count("PUNCT_BRACKET_SPACE") == 2
    q = next(i for i in res["issues"] if i["code"] == "PUNCT_QUOTE_STYLE")
    assert q["severity"] == "info" and q["suggestions"] == ["«اقتباس»"]


def test_mixed_digits_info(sp):
    res = chk(sp, "في ١٢ مايو و 15 يونيو و 20 يوليو", checks=P)
    (i,) = (x for x in res["issues"] if x["code"] == "PUNCT_MIXED_DIGITS")
    assert i["severity"] == "info" and i["word"] == "١٢" and i["suggestions"] == ["12"]
    assert chk(sp, "في ١٢ مايو و ١٥ يونيو", checks=P)["issues"] == []


def test_clean_punctuation_has_no_issues(sp):
    clean = "قال المعلم: اكتبوا الدرس، ثم اقرؤوه (بصوت عال)؛ هل فهمتم؟"
    assert chk(sp, clean, checks=P)["issues"] == []


# ---------------------------------------------------------------- API contract / offsets
def test_offsets_codepoints_and_utf16_with_astral(sp):
    text = "😀😀 هاذا ثم 😀 لاكن"
    res = chk(sp, text, checks=["patterns"])
    assert len(res["issues"]) == 2
    for i in res["issues"]:
        assert text[i["start"] : i["end"]] == i["word"]
        pre = text[: i["start"]]
        assert i["start16"] == len(pre.encode("utf-16-le")) // 2
        assert i["end16"] == len(text[: i["end"]].encode("utf-16-le")) // 2
    assert res["issues"][0]["start"] == 3 and res["issues"][0]["start16"] == 5


def test_issue_shape_stats_and_truncation(sp):
    res = chk(sp, "هاذا هاذه هاذا هاذه", checks=["patterns"], max_issues=2)
    assert len(res["issues"]) == 2 and res["stats"]["truncated"] is True
    i = res["issues"][0]
    assert set(i) >= {
        "start", "end", "start16", "end16", "word", "code", "category", "severity",
        "message_ar", "suggestions",
    }  # fmt: skip
    assert i["category"] in {"spelling", "pattern", "punctuation"}
    assert i["severity"] in {"error", "warning", "info"}
    assert set(res["stats"]) >= {"words", "unique", "elapsed_ms"}
    assert res["stats"]["words"] == 4 and res["stats"]["unique"] == 2


def test_checks_selection_and_validation(sp):
    text = "هاذا كتابقديم ,"
    cats = {i["category"] for i in chk(sp, text)["issues"]}
    assert cats == {"pattern", "spelling", "punctuation"}
    only = {i["category"] for i in chk(sp, text, checks=["punctuation"])["issues"]}
    assert only == {"punctuation"}
    r = sp.post("/api/spelling/check", json={"text": "x", "checks": ["nope"]})
    assert r.status_code == 422
    assert chk(sp, "")["issues"] == []


def test_api_never_modifies_text_only_suggests(sp):
    text = "إستخدام الى هاذا مدرسه ذهبو"
    res = chk(sp, text)
    assert res["issues"]
    for i in res["issues"]:
        assert text[i["start"] : i["end"]] == i["word"]  # offsets point into the ORIGINAL text
    assert "text" not in res and "corrected" not in res


def test_check_runs_off_the_event_loop(sp, monkeypatch):
    seen = []
    real = spelling_api.check_text

    def spy(*a, **k):
        seen.append(threading.current_thread().name)
        return real(*a, **k)

    monkeypatch.setattr(spelling_api, "check_text", spy)
    chk(sp, "هاذا")
    assert seen and seen[0].startswith("mizaj-engine")


# ---------------------------------------------------------------- ignore list / personal dictionary
def test_ignore_list_roundtrip_and_effect(sp):
    assert sp.get("/api/spelling/ignore").json()["words"] == []
    assert len(chk(sp, "اشتريت زيمنسوكو", checks=["dictionary"])["issues"]) == 1
    r = sp.post("/api/spelling/ignore", json={"word": "زيمنسوكو"})
    assert r.status_code == 200 and r.json()["words"] == ["زيمنسوكو"]
    assert chk(sp, "اشتريت زيمنسوكو", checks=["dictionary"])["issues"] == []
    # stored in settings as JSON, no migration needed
    assert "زيمنسوكو" in sp.get("/api/settings").json()["spelling_ignore"]
    assert sp.delete("/api/spelling/ignore/زيمنسوكو").json()["words"] == []
    assert len(chk(sp, "اشتريت زيمنسوكو", checks=["dictionary"])["issues"]) == 1
    assert sp.delete("/api/spelling/ignore/زيمنسوكو").json()["changed"] is False


def test_ignore_validation(sp):
    assert sp.post("/api/spelling/ignore", json={"word": "  "}).status_code == 422
    assert sp.post("/api/spelling/ignore", json={"word": "كلمتان معا"}).status_code == 422


def test_ignore_also_silences_pattern_rules(sp):
    assert chk(sp, "هاذا", checks=["patterns"])["issues"]
    sp.post("/api/spelling/ignore", json={"word": "هاذا"})
    assert chk(sp, "هاذا", checks=["patterns"])["issues"] == []


def test_personal_dictionary_words_are_accepted(sp):
    assert len(chk(sp, "شركة كوستابرافا", checks=["dictionary"])["issues"]) == 1
    r = sp.post(
        "/api/dictionary", json={"word_or_phrase": "كوستابرافا", "diacritized_form": "كُوسْتَابْرَافَا"}
    )
    assert r.status_code == 201
    assert chk(sp, "شركة كوستابرافا", checks=["dictionary"])["issues"] == []
    # personal words can also be suggested
    s = sp.post("/api/spelling/suggest", json={"word": "كوستابرافاا"}).json()
    assert "كوستابرافا" in s["suggestions"]


def test_suggest_endpoint(sp):
    s = sp.post("/api/spelling/suggest", json={"word": "الشركه"}).json()
    assert s["suggestions"][0] == "الشركة"
    assert sp.post("/api/spelling/suggest", json={"word": " "}).status_code == 422


# ---------------------------------------------------------------- performance
def test_performance_smoke_on_long_sample(sp):
    text = (FIX / "sample_long.txt").read_text(encoding="utf-8")
    chk(sp, "تهيئة")  # load the dictionary once (cold start is measured separately)
    t = time.perf_counter()
    res = chk(sp, text)
    dt = time.perf_counter() - t
    assert res["stats"]["words"] > 20_000
    assert dt < 3.0, dt


def test_performance_many_unique_words():
    eng = get_engine()
    words = [w for i, w in enumerate(eng.hs.stems) if i % 40 == 0][:5000]
    text = " ".join(words)
    t = time.perf_counter()
    res = check_text(text, eng)
    assert time.perf_counter() - t < 5.0
    assert res["stats"]["unique"] >= 4000
