"""Proofreading before tashkeel: hamza -> spelling -> final ya -> punctuation (suggestions only).

The sentences come from a real Egyptian legal memo and the owner's own corrections of it
(`fixtures/proofread_owner_sentences.tsv`: original <TAB> owner-corrected).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.api import proofread as proofread_api
from app.spelling.engine import get_engine
from app.spelling.proofread import ProofreadOptions, apply_items, proofread

FIX = Path(__file__).parent / "fixtures" / "proofread_owner_sentences.tsv"
MARKS = re.compile("[ً-ْٰـ]")
BASE = ("hamza", "spelling", "ya")


def strip(s: str) -> str:
    return MARKS.sub("", s)


def pairs() -> list[tuple[str, str]]:
    rows = [ln.split("\t") for ln in FIX.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return [(a, b) for a, b in rows]


def run(text: str, style: str = "egyptian", cats=BASE, **kw) -> dict:
    return proofread(text, get_engine(), ProofreadOptions(ya_style=style, categories=cats), **kw)


def fixed(text: str, style: str = "egyptian", cats=BASE) -> str:
    res = run(text, style, cats)
    return apply_items(text, res["items"])["text"]


# --------------------------------------------------------------------------- data contract
def test_item_shape_and_no_auto_apply():
    text = "محكمة ابو حمص"
    res = run(text)
    assert res["items"], res
    it = res["items"][0]
    for key in (
        "id",
        "start",
        "end",
        "original",
        "replacement",
        "category",
        "reason_ar",
        "confidence",
    ):
        assert key in it
    assert it["category"] in ("hamza", "spelling", "ya", "punctuation")
    assert text[it["start"] : it["end"]] == it["original"] == "ابو"
    assert it["replacement"] == "أبو" and it["reason_ar"]
    assert 0 < it["confidence"] <= 1
    assert it["suggestion_only"] is True
    assert text == "محكمة ابو حمص"  # the input is never modified


def test_utf16_offsets_for_astral_characters():
    text = "😀 ابو"
    it = run(text)["items"][0]
    assert it["start"] == 2 and it["start16"] == 3 and it["end16"] == 6


def test_apply_skips_stale_items():
    text = "قال ابو علي"
    it = run(text)["items"][0]
    out = apply_items("قال ابو علي", [{**it, "original": "xxx"}])
    assert out["applied"] == 0 and out["skipped"] and out["text"] == text
    assert apply_items(text, [it])["text"] == "قال أبو علي"


# --------------------------------------------------------------------------- owner's corrections
@pytest.mark.parametrize(
    ("src", "want"),
    [
        ("محكمة ابو حمص الكلية", "محكمة أبو حمص الكلية"),
        ("مدنى كلى ابوحمص", "مدنى كلى أبوحمص"),
        ("وزير العدل واخرين", "وزير العدل وآخرين"),
        ("فى ان المدعي اقام الدعوى", "فى أن المدعي أقام الدعوى"),
        ("ليكون الاجمالى", "ليكون الإجمالى"),
        ("وبالغاء امرى تقدير", "وبإلغاء أمرى تقدير"),
        (
            "فضلا عن الزام المدعى عليهم بالمصروفات والاتعاب",
            "فضلا عن إلزام المدعى عليهم بالمصروفات والأتعاب",
        ),
        ("مشار اليه ومشار اليهما", "مشار إليه ومشار إليهما"),
        ("دون اية مصاريف", "دون أية مصاريف"),
        ("وقد استقرت احكام النقض على هذا الاساس", "وقد استقرت أحكام النقض على هذا الأساس"),
        ("بالموقع الالكتروني", "بالموقع الإلكتروني"),
        ("للدكتور/احمد مليجى", "للدكتور/أحمد مليجى"),
        ("تأييد امر تقدير الرسوم", "تأييد أمر تقدير الرسوم"),
        ("في الاحوال والاصلية", "في الأحوال والأصلية"),
    ],
)
def test_hamza_restoration(src, want):
    assert fixed(src, cats=("hamza",)) == want


@pytest.mark.parametrize(
    ("src", "want"),
    [
        ("والإجتماعية لأعضاء الهيئات", "والاجتماعية لأعضاء الهيئات"),
        ("الإلتزام بسداد الرسوم", "الالتزام بسداد الرسوم"),
        ("إقتضاء الحق", "اقتضاء الحق"),
        ("إستئناف الحكم", "استئناف الحكم"),
    ],
)
def test_wrong_hamza_on_wasl_nouns_is_removed(src, want):
    res = run(src, cats=("hamza",))
    assert apply_items(src, res["items"])["text"] == want
    assert "همزة الوصل" in res["items"][0]["reason_ar"]


@pytest.mark.parametrize(
    "ok",
    [
        "اجتماع الجمعية العمومية",
        "الالتزام والاقتضاء والانعدام والاستئناف",
        "الاجتماعية والاقتصادية والاستثنائية",
        "اسم الشركة وابن الموظف وامرأة",
        "انتهاء المدة واتصال الطرفين",
        "إجراءات التقاضي وإنذار المدين وإصدار الحكم",
        "أبو حمص وأحمد وأقام الدعوى وإلى المحكمة",
        "كان الحق للمدعي ولاسيما سالف الذكر وباب الطعن",
    ],
)
def test_correct_text_yields_no_base_item(ok):
    assert run(ok, "egyptian", ("hamza", "spelling"))["items"] == []


# --------------------------------------------------------------------------- إنّ / أنّ
@pytest.mark.parametrize(
    ("src", "want"),
    [
        ("وقالت شرحا لدعواها: انها أعلنت", "وقالت شرحا لدعواها: إنها أعلنت"),  # after a colon
        ("وحيث أن الحكم قد ألزم", "وحيث إن الحكم قد ألزم"),  # حيث إن
        ("قال المدير ان العمل انتهى", "قال المدير إن العمل انتهى"),  # after قال
        ("ومن ثم فان مطالبته", "ومن ثم فإن مطالبته"),
        ("وبان :", "وبأن :"),
        ("على انه يفرض رسم", "على أنه يفرض رسم"),
        ("يجب ان يكون الحكم", "يجب أن يكون الحكم"),
        ("لان القانون", "لأن القانون"),
    ],
)
def test_inna_anna(src, want):
    assert fixed(src, cats=("hamza",)) == want


def test_inna_item_carries_the_alternative():
    it = run("يجب ان يكون")["items"][0]
    assert it["replacement"] == "أن" and it["alternatives"] == ["إن"]


def test_ban_verb_is_left_alone():
    assert run("بان الحق وظهر الباطل", cats=("hamza",))["items"] == []


# --------------------------------------------------------------------------- spelling
def test_typos_the_owner_missed():
    assert fixed("إنشاء صندق للخدمات", cats=("spelling",)) == "إنشاء صندوق للخدمات"
    assert fixed("ونعيت علي أمر التقدير", cats=("spelling",)) == "ونعت علي أمر التقدير"
    assert fixed("دون اية طلب من الخصوم", cats=("spelling",)) == "دون أي طلب من الخصوم"
    assert fixed('السيد/ فلانة "مدعيه "', cats=("spelling",)) == 'السيد/ فلانة "مدعية "'
    # «مدعيه» followed by a noun is a different (possessive) construction: untouched
    assert run("اعتراض مدعيه على الحكم", cats=("spelling",))["items"] == []


def test_split_waw_is_punctuation_not_spelling():
    assert run("لما كان ذلك و كان الثابت", cats=("spelling",))["items"] == []


# --------------------------------------------------------------------------- final ya
def test_etymological_alef_maqsura_is_fixed_in_both_styles():
    for style in ("standard", "egyptian"):
        assert fixed("ونعت علي أمر التقدير", style, ("ya",)) == "ونعت على أمر التقدير"
        assert fixed("علي من ألزمه الحكم", style, ("ya",)) == "على من ألزمه الحكم"
        assert fixed("المقضي فيها برفض الدعوي", style, ("ya",)).endswith("الدعوى")
        assert fixed("حتي الآن", style, ("ya",)) == "حتى الآن"
        assert fixed("للمدعي عليهما", style, ("ya",)) == "للمدعى عليهما"
        assert fixed("الحكم المسوي عليه الرسوم", style, ("ya",)) == "الحكم المسوى عليه الرسوم"


def test_plaintiff_and_names_keep_their_yaa():
    for style in ("standard", "egyptian"):
        assert run("برفض الدعوى وإلزام المدعي بالمصروفات", style, ("ya",))["items"] == [] or all(
            i.get("style")
            for i in run("برفض الدعوى وإلزام المدعي بالمصروفات", style, ("ya",))["items"]
        )
        assert run("السيد/ علي محمد وعلي بن أبي طالب", style, ("ya",))["items"] == []


def test_ya_style_setting_direction():
    # standard: ى -> ي on true-yaa words
    std = run("في الدعوى مدنى والذى", "standard", ("ya",))["items"]
    assert {i["original"]: i["replacement"] for i in std} == {
        "مدنى": "مدني",
        "والذى": "والذي",
    }
    assert all(i["style"] for i in std)
    # egyptian: nothing to change toward ي, and the standard ي is offered as ى
    egy = run("في الدعوى مدني والذي", "egyptian", ("ya",))["items"]
    assert {i["original"]: i["replacement"] for i in egy} == {
        "في": "فى",
        "مدني": "مدنى",
        "والذي": "والذى",
    }
    assert run("لدى الدعوى حتى على إلى", "standard", ("ya",))["items"] == []
    assert run("لدى الدعوى حتى على إلى", "egyptian", ("ya",))["items"] == []


def test_standard_style_merges_into_hamza_item():
    # the hamza item already rewrites the word; the style letter is part of it (and explained)
    it = run("ليكون الاجمالى", "standard", ("hamza", "ya"))["items"][0]
    # «اجمالي» is not a style-flip class (only في، الذي/التي، nisba): the letter is kept
    assert it["replacement"] == "الإجمالى"
    it = run("ليكون الاجمالى", "egyptian", ("hamza", "ya"))["items"][0]
    assert it["replacement"] == "الإجمالى"


def test_tashkeel_is_preserved_when_only_letters_change():
    it = run("وَقَالَ ابو حمص")["items"][0]
    assert it["original"] == "ابو" and strip(it["replacement"]) == "أبو"
    it = run("عَلِي أنَّ")["items"][0]
    assert it["replacement"] == "عَلِى"


def test_quran_and_ignored_words_are_not_touched():
    text = "ابو حمص"
    res = proofread(text, get_engine(), ProofreadOptions(categories=BASE), protected=[(0, 3)])
    assert res["items"] == []
    res = proofread(text, get_engine(), ProofreadOptions(categories=BASE), ignored={"ابو"})
    assert res["items"] == []


# --------------------------------------------------------------------------- punctuation
def pfix(text: str) -> str:
    return fixed(text, cats=("punctuation",))


def test_space_before_marks_and_quotes_and_parens():
    assert pfix("في الدعوى ، والمحدد لنظرها : جلسة .") == "في الدعوى، والمحدد لنظرها: جلسة."
    assert pfix('قال " مدعى عليهم " ثم') == 'قال "مدعى عليهم" ثم'
    assert pfix("المادة ( 3 / 1 ) من القانون") == "المادة (3 / 1) من القانون"
    assert pfix("جزئية ) بصفتيهما") == "جزئية) بصفتيهما"


def test_quotes_spanning_lines_keep_pairing():
    text = 'بأن :  " لما كان\nمن المقرر "\nوبأن : " ثم "'
    assert pfix(text) == 'بأن:  "لما كان\nمن المقرر"\nوبأن: "ثم"'


def test_colon_dash_and_dots_and_latin_marks_and_waw():
    assert pfix('على أنه :- "يلزم') == 'على أنه: "يلزم'
    assert pfix('بأن:-\n"يفرض') == 'بأن:\n"يفرض'
    assert pfix("غير مقبول..") == "غير مقبول."
    assert pfix("الرسوم .......... ثم") == "الرسوم .......... ثم".replace("..........", "…")
    long_run = "الأسماء " + "." * 40
    assert pfix(long_run) == long_run  # fill-in lines are not ellipses
    assert pfix("الكتاب, والقلم") == "الكتاب، والقلم"
    assert pfix("لما كان ذلك و فى مواجهة الغير") == "لما كان ذلك وفى مواجهة الغير"


def test_punctuation_leaves_numbers_times_and_latin_alone():
    ok = "الساعة 10 : 30 والمبلغ 4.5 جنيه و 12 يوما، Hello , world"
    assert pfix(ok) == ok


def test_long_layout_gaps_are_not_reported():
    text = "قسم الكليات" + " " * 30 + "محكمة ابو حمص"
    assert run(text, cats=("punctuation",))["items"] == []


# --------------------------------------------------------------------------- evaluation
def evaluate(style: str = "egyptian") -> dict:
    """Word-level recall / precision of the base-letter proposals against the owner's text."""
    hits = expected = items_n = tp_items = 0
    for src, gold in pairs():
        sw, gw = src.split(), gold.split()
        assert len(sw) == len(gw), src
        spans = [(m.start(), m.end()) for m in re.finditer(r"\S+", src)]
        its = [i for i in run(src, style, BASE)["items"] if not i.get("style")]
        for (s, e), w, g in zip(spans, sw, gw, strict=True):
            inside = [i for i in its if s <= i["start"] < e]
            out, pos = [], s
            for i in inside:
                out.append(src[pos : i["start"]])
                out.append(i["replacement"])
                pos = i["end"]
            out.append(src[pos:e])
            need = strip(w) != strip(g)
            expected += need
            items_n += len(inside)
            if need and strip("".join(out)) == strip(g):
                hits += 1
                tp_items += len(inside)
            elif not need and not inside:
                continue
    return {
        "recall": hits / expected,
        "precision": tp_items / max(items_n, 1),
        "expected": expected,
    }


def test_owner_sentences_recall_and_precision():
    m = evaluate("egyptian")
    assert m["expected"] >= 28
    assert m["recall"] >= 0.85, m
    assert m["precision"] >= 0.90, m


def test_owner_corrected_text_is_clean():
    """The owner's corrected sentences produce no hamza / spelling proposal (no false positives)."""
    for _, gold in pairs():
        its = run(gold, "egyptian", ("hamza", "spelling"))["items"]
        its = [i for i in its if i["original"] != "اية" and i["replacement"] != "أي"]
        assert its == [], (gold, its)


# --------------------------------------------------------------------------- HTTP API
def test_api_proofread_and_apply(client):
    text = "فى ان ابو حمص اقام الدعوى ، علي الاساس"
    r = client.post("/api/proofread", json={"text": text})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["ya_style"] == "standard"
    cats = {i["category"] for i in data["items"]}
    assert {"hamza", "punctuation"} <= cats
    assert set(data["counts"]) == {"hamza", "spelling", "ya", "punctuation"}
    assert data["labels_ar"]["hamza"] == "همزات"
    assert all(i["suggestion_only"] for i in data["items"])
    # accept only the punctuation ones: base letters stay exactly as typed
    accepted = [i for i in data["items"] if i["category"] == "punctuation"]
    r = client.post("/api/proofread/apply", json={"text": text, "items": accepted})
    out = r.json()
    assert out["applied"] == len(accepted)
    assert out["text"].startswith("فى ان ابو حمص اقام الدعوى،")
    # accept everything
    r = client.post("/api/proofread/apply", json={"text": text, "items": data["items"]})
    assert r.json()["text"] == "في أن أبو حمص أقام الدعوى، على الأساس"


def test_api_ya_style_comes_from_the_saved_setting(client):
    body = {"text": "في الدعوى مدنى", "categories": ["ya"]}
    std = client.post("/api/proofread", json=body).json()
    assert [i["replacement"] for i in std["items"]] == ["مدني"]
    assert client.put("/api/settings", json={"ya_style": "egyptian"}).status_code == 200
    egy = client.post("/api/proofread", json=body).json()
    assert egy["ya_style"] == "egyptian"
    assert [i["replacement"] for i in egy["items"]] == ["فى"]
    # an explicit request value wins over the setting
    again = client.post("/api/proofread", json={**body, "ya_style": "standard"}).json()
    assert [i["replacement"] for i in again["items"]] == ["مدني"]


def test_api_settings_validate_the_new_keys(client):
    assert client.put("/api/settings", json={"ya_style": "weird"}).status_code == 422
    assert client.put("/api/settings", json={"proofread_before_tashkeel": "x"}).status_code == 422
    r = client.put("/api/settings", json={"proofread_before_tashkeel": "auto_punct"})
    assert r.json()["proofread_before_tashkeel"] == "auto_punct"


def test_api_apply_reports_stale_items(client):
    r = client.post(
        "/api/proofread/apply",
        json={
            "text": "قال ابو",
            "items": [
                {"start": 4, "end": 7, "original": "ابو", "replacement": "أبو"},
                {"start": 0, "end": 3, "original": "xxx", "replacement": "y"},
            ],
        },
    )
    out = r.json()
    assert out["text"] == "قال أبو" and out["applied"] == 1 and len(out["skipped"]) == 1


def test_fixed_names_and_owner_decisions():
    """«أبو» in place names stays أبو (never أبي/أبا); خدمات / حمص get no proposal at all."""
    for text in ("محكمة أبو حمص الكلية", "محكمة ابو حمص", "صندوق خدمات قدره", "حُمُّص وخَدَمَات"):
        for style in ("standard", "egyptian"):
            for it in run(text, style)["items"]:
                assert strip(it["replacement"]) == "أبو", it
    assert run("صندوق خدمات قدره حمص", "egyptian", ("hamza", "spelling"))["items"] == []
    assert ProofreadOptions().ya_style == "standard"


@pytest.mark.parametrize("style", ["egyptian", "standard"])
def test_style_flip_never_changes_the_reading(style):
    """المدعي (plaintiff) vs المدعى (defendant), present verbs and construct forms stay put."""
    safe = (
        "برفض الدعوى وإلزام المدعي بالمصروفات والمدعي بصفته",
        "من يدعي استحقاقه ويؤدي الرسوم وهو يلي الأمر ويماري ولا تنتهي الخصومة",
        "القاضي والباقي والراعي والداعي والماضي والمحامي والمقضي والتداعي",
        "تقدير أمري الرسوم وقرارَي المحكمة",
        "وتقضي المحكمة والتصدي للنعي",
    )
    for text in safe:
        items = run(text, style, ("ya",))["items"]
        assert items == [], (style, text, items)


def test_egyptian_style_flip_is_limited_to_fi_relatives_and_nisba():
    items = run("في الذي والتي وبالذي مدني قانوني نهائي كلي والمدعي ويدعي", "egyptian", ("ya",))
    got = {i["original"]: i["replacement"] for i in items["items"]}
    allowed = {"في", "الذي", "والتي", "وبالذي", "مدني", "قانوني", "نهائي", "كلي"}
    assert set(got) <= allowed, got
    assert {"في", "الذي", "والتي", "مدني", "قانوني", "كلي"} <= set(got), got
    assert got["في"] == "فى" and got["مدني"] == "مدنى"
    assert "المدعي" not in got and "ويدعي" not in got
    # the reverse direction (standard) is just as narrow
    std = run("فى الذى مدنى والمدعى عليه ويدعى", "standard", ("ya",))["items"]
    assert {i["original"] for i in std} <= {"فى", "الذى", "مدنى"}


def test_module_exports():
    assert proofread_api.router.prefix == "/api/proofread"
