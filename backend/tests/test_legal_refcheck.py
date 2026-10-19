"""Date / case-number / article / law-citation warnings (suggestions only)."""

import datetime as dt

import pytest
from fastapi.testclient import TestClient

from app.legal.refcheck import RULES, check_refs

TODAY = dt.date(2026, 10, 19)


def issues(text: str, **kw) -> list[dict]:
    return check_refs(text, today=TODAY, **kw)["issues"]


def rules(text: str, **kw) -> set[str]:
    return {i["rule"] for i in issues(text, **kw)}


def one(text: str, rule: str) -> dict:
    got = [i for i in issues(text) if i["rule"] == rule]
    assert got, f"{rule} not raised for {text!r}: {rules(text)}"
    return got[0]


# ------------------------------------------------------------------ impossible dates
@pytest.mark.parametrize(
    "text",
    [
        "بتاريخ 31/2/2026",
        "بتاريخ 30/2/2024",
        "بتاريخ 29/2/2025",  # not a leap year
        "بتاريخ 31/4/2025",
        "بتاريخ 5/13/2026",  # month 13
        "بتاريخ 12/0/2026",
        "بتاريخ 0/5/2026",
        "بتاريخ ٣١/٢/٢٠٢٦",  # Arabic-Indic digits
        "بتاريخ 2026/13/5",
        "بتاريخ 32/1/2026",
        "بتاريخ 31 فبراير 2026",
        "بتاريخ 31/3/1447 هـ",  # Hijri months have at most 30 days
        "بتاريخ 15/13/1447 هـ",
    ],
)
def test_impossible_dates(text):
    assert "date_impossible" in rules(text)


@pytest.mark.parametrize(
    "text",
    [
        "بتاريخ 29/2/2024",  # leap year
        "بتاريخ 28/2/2026",
        "بتاريخ 31/12/2025",
        "بتاريخ 30/7/2026",
        "بتاريخ 2026/7/30",
        "بتاريخ 30/9/1447 هـ",
        "بتاريخ 30 يوليو 2026",
        "المادة 3/1/2",  # three numbers but no 4-digit year: not a date
        "البند 1.2.3",
        "الفترة 2025 - 2026",
        "رقم 624/2026",
        "نص بلا تواريخ",
    ],
)
def test_valid_dates_not_flagged(text):
    assert "date_impossible" not in rules(text)


def test_impossible_date_has_position_message_and_no_edit():
    t = "حرر العقد بتاريخ 31/2/2026 بين الطرفين"
    i = one(t, "date_impossible")
    assert t[i["start"] : i["end"]] == "31/2/2026" == i["text"]
    assert "غير ممكن" in i["message_ar"]
    assert "fix" not in i  # suggestion only


def test_month_swapped_hint():
    assert "مقلوبان" in one("بتاريخ 5/13/2026", "date_impossible")["message_ar"]


# ------------------------------------------------------------------ future dates
@pytest.mark.parametrize(
    "text",
    [
        "صدر الحكم بتاريخ 15/12/2027",
        "أقام المدعي الدعوى بتاريخ 3/5/2027",
        "تحرر العقد بتاريخ 1/1/2030",
        "توفي المورث بتاريخ 9/9/2028",
    ],
)
def test_future_date_for_past_event(text):
    assert "date_future" in rules(text)


@pytest.mark.parametrize(
    "text",
    [
        "وحددت لنظرها جلسة 15/12/2027",
        "ينتهي العقد بتاريخ 15/12/2030",
        "صدر الحكم بتاريخ 15/12/2025",  # in the past
        "بتاريخ 15/12/2027",  # no clear past-event cue
        "سيتم التسليم بتاريخ 1/1/2030 وصدر الاتفاق",
        "صدر الحكم بتاريخ 19/10/2026",  # today is not the future
    ],
)
def test_future_date_not_flagged(text):
    assert "date_future" not in rules(text)


# ------------------------------------------------------------------ sessions vs filing
def test_session_before_case_year():
    t = "الدعوى رقم 624 لسنة 2026 مدني كلي\nالمحدد لنظرها جلسة 30/7/2025"
    i = one(t, "session_before_filing")
    assert i["text"] == "30/7/2025"
    assert "related" in i


def test_session_before_explicit_filing_date():
    t = "الدعوى رقم 5 لسنة 2026\nأودعت الصحيفة بتاريخ 10/5/2026\nوتحددت جلسة 1/3/2026"
    assert "session_before_filing" in rules(t)


@pytest.mark.parametrize(
    "t",
    [
        "الدعوى رقم 624 لسنة 2026\nجلسة 30/7/2026",
        "الدعوى رقم 624 لسنة 2026\nجلسة 1/1/2027",
        "جلسة 30/7/2025",  # no case year to compare with
        "الطعن رقم 5517 لسنة 70 ق\nجلسة 3/4/1995",  # judicial year, not calendar
        "الدعوى رقم 5 لسنة 2026\nأودعت الصحيفة بتاريخ 10/5/2026\nجلسة 1/6/2026",
        "الدعوى رقم 5 لسنة 2026\nصدر الحكم بتاريخ 3/3/2025",  # not a session
    ],
)
def test_session_not_before_filing(t):
    assert "session_before_filing" not in rules(t)


# ------------------------------------------------------------------ year ranges
def test_year_range_mismatch_with_case_year():
    t = "الدعوى رقم 5 لسنة 2024\nالعام القضائي 2025 - 2026"
    i = one(t, "year_range_mismatch")
    assert i["text"] == "2025 - 2026"


def test_year_range_non_consecutive_and_reversed():
    assert "year_range_mismatch" in rules("للعام المالي 2025 - 2027")
    assert "year_range_mismatch" in rules("للعام المالي 2026 - 2025")


@pytest.mark.parametrize(
    "t",
    [
        "الدعوى رقم 5 لسنة 2026\nالعام القضائي 2025 - 2026",
        "الدعوى رقم 5 لسنة 2025\nالعام القضائي 2025/2026",
        "للعام المالي 2025 - 2026",
        "مدة العقد 2020 - 2030",  # a contract term, no year-word context
        "الدعوى رقم 5 لسنة 2024\nمن 2025 - 2026",  # no context
    ],
)
def test_year_range_ok(t):
    assert "year_range_mismatch" not in rules(t)


# ------------------------------------------------------------------ calendar sanity
@pytest.mark.parametrize(
    "t",
    [
        "في سنة 1447 م",
        "بتاريخ 3/2/1447 م",
        "في سنة 2026 هـ",
        "بتاريخ 3/2/2026 هـ",
        "في سنة 1700 هـ",
    ],
)
def test_calendar_format_warnings(t):
    assert "calendar_format" in rules(t)


@pytest.mark.parametrize(
    "t",
    ["في سنة 1447 هـ", "في سنة 2026 م", "بتاريخ 3/2/1447هـ", "بتاريخ 3/2/2026 ميلادي", "عام 2026"],
)
def test_calendar_format_ok(t):
    assert "calendar_format" not in rules(t)


# ------------------------------------------------------------------ case numbers
def test_case_number_same_number_other_year():
    t = "الدعوى رقم 624 لسنة 2026\n" + "ن " * 20 + "\nوفي الدعوى رقم 624 لسنة 2025"
    assert "case_number_inconsistent" in rules(t)


def test_case_number_typo_vs_header():
    t = "الدعوى رقم 624 لسنة 2026 مدني كلي\nوإذ تداولت الدعوى رقم 642 لسنة 2026"
    i = one(t, "case_number_inconsistent")
    assert "624 لسنة 2026" in i["message_ar"]


def test_case_number_present_case_mismatch():
    t = "الدعوى رقم 624 لسنة 2026\nوأقام الدعوى الماثلة رقم 900 لسنة 2026"
    assert "case_number_inconsistent" in rules(t)


@pytest.mark.parametrize(
    "t",
    [
        "الدعوى رقم 624 لسنة 2026\nوالدعوى رقم 624 لسنة 2026",
        "الدعوى رقم 624 لسنة 2026\nوالدعوى رقم 100 لسنة 2025",  # a different case
        "الدعوى رقم 624 لسنة 2026\nوالطعن رقم 624 لسنة 70 ق",  # other kind
        "الدعوى رقم 624 لسنة 2026",
        "الدعوى رقم 624 لسنة 2026\nوقضت محكمة النقض في الطعن رقم 642 لسنة 2026",  # precedent
    ],
)
def test_case_number_consistent(t):
    assert "case_number_inconsistent" not in rules(t)


# ------------------------------------------------------------------ article format
@pytest.mark.parametrize(
    "t",
    [
        "المادة ( 3 / 1 )",
        "المادة (3 / 1)",
        "المادة ( 5 )",
        "المادة (5",
        "المادة [5)",
        "المادة 3 /1",
        "المادة (007)",
        "المادة )5(",
        "المادة (٣ / ١)",
    ],
)
def test_article_malformed(t):
    assert "article_malformed" in rules(t)


def test_article_malformed_suggestion_is_text_only():
    t = "وفق المادة ( 3 / 1 ) من القانون"
    i = one(t, "article_malformed")
    assert i["text"] == "المادة ( 3 / 1 )"
    assert "المادة (3/1)" in i["message_ar"]
    assert t[i["start"] : i["end"]] == i["text"]


@pytest.mark.parametrize(
    "t",
    [
        "المادة (3/1)",
        "المادة 5",
        "المادة (147)",
        "المادة 5 مكرر (أ)",
        "المادة (5) من القانون",
        "(المادة 5)",
        "مادة 12",
    ],
)
def test_article_well_formed(t):
    assert "article_malformed" not in rules(t)


@pytest.mark.parametrize(
    "t",
    [
        "المادة 0",
        "المادة (0)",
        "المادة 99999",
        "المادة 3/0",
        "المواد من 9 إلى 5",
        "المادة 12 إلى المادة 3",
    ],
)
def test_article_impossible(t):
    assert "article_impossible" in rules(t)


@pytest.mark.parametrize("t", ["المادة 1149", "المادة 3000", "المواد من 5 إلى 9", "المادة 7/2"])
def test_article_possible(t):
    assert "article_impossible" not in rules(t)


# ------------------------------------------------------------------ article consistency
def test_same_provision_cited_with_two_numbers():
    t = (
        "المادة (147) من القانون المدني تنص على أن العقد شريعة المتعاقدين فلا يجوز نقضه.\n"
        "وتأكيدا لذلك فإن المادة (174) من القانون المدني تنص على أن العقد شريعة المتعاقدين فلا يجوز نقضه."  # noqa: E501
    )
    got = [i for i in issues(t) if i["rule"] == "article_inconsistent"]
    assert got and got[0]["severity"] == "warning"
    assert "147" in got[0]["message_ar"] and "174" in got[0]["message_ar"]


def test_transposed_article_numbers_for_same_law_are_info():
    t = "المادة 147 من القانون المدني، ثم المادة 174 من القانون المدني"
    got = [i for i in issues(t) if i["rule"] == "article_inconsistent"]
    assert got and got[0]["severity"] == "info"


@pytest.mark.parametrize(
    "t",
    [
        "المادة 147 من القانون المدني والمادة 148 من القانون المدني",
        "المادة 147 من القانون المدني والمادة 174 من قانون العقوبات",  # different laws
        "المادة 147 من القانون المدني تنص على أن العقد شريعة المتعاقدين\n"
        "المادة 147 من القانون المدني تنص على أن العقد شريعة المتعاقدين",  # same number
        "المادة 147 من القانون المدني تنص على أن العقد شريعة المتعاقدين\n"
        "المادة 150 من القانون المدني تنص على أنه إذا كانت عبارة العقد واضحة",  # other text
    ],
)
def test_article_consistent(t):
    assert "article_inconsistent" not in rules(t)


# ------------------------------------------------------------------ law number / year
@pytest.mark.parametrize(
    "t",
    [
        "القانون رقم 90 لسنة 1944 ثم القانون رقم 90 لسنة 1945",
        "قانون الرسوم القضائية رقم 90 لسنة 1944 وكذا القانون رقم 90 لسنة 1954",  # one-digit typo
        "القرار بقانون رقم 12 لسنة 2020 والقرار بقانون رقم 12 لسنة 2021",
        "اللائحة رقم 3 لسنة 2019 ثم اللائحة رقم 3 لسنة 2018",
    ],
)
def test_law_number_inconsistent(t):
    i = one(t, "law_number_inconsistent")
    assert i["start"] < i["end"] and "related" in i


@pytest.mark.parametrize(
    "t",
    [
        "القانون رقم 90 لسنة 1944 والقانون رقم 90 لسنة 1944",
        "القانون رقم 90 لسنة 1944 والقانون رقم 90 لسنة 2005",  # far apart: different laws
        "القانون رقم 90 لسنة 1944 والقرار رقم 90 لسنة 1945",  # law vs decree
        "القانون رقم 90 لسنة 1944 والقانون رقم 91 لسنة 1944",
        "الدعوى رقم 90 لسنة 1944",
    ],
)
def test_law_number_consistent(t):
    assert "law_number_inconsistent" not in rules(t)


# ------------------------------------------------------------------ API and plumbing
def test_rule_controls_and_shape():
    t = "بتاريخ 31/2/2026 المادة 0"
    assert rules(t, disabled=["date_impossible"]) == {"article_impossible"}
    assert rules(t, rules=["date_impossible"]) == {"date_impossible"}
    r = check_refs(t, today=TODAY)
    assert r["count"] == len(r["issues"]) == sum(r["by_rule"].values())
    for i in r["issues"]:
        assert i["rule"] in RULES and i["message_ar"] and i["message_en"]
        assert t[i["start"] : i["end"]] == i["text"]
    assert [i["start"] for i in r["issues"]] == sorted(i["start"] for i in r["issues"])


def test_clean_text_has_no_issues():
    t = "الدعوى رقم 624 لسنة 2026 مدني كلي\nجلسة 30/7/2026\nوفقا للمادة (147) من القانون المدني"
    assert issues(t) == []


def test_empty_text():
    assert check_refs("")["issues"] == []


def test_positions_are_code_points_after_astral_chars():
    t = "😀 بتاريخ 31/2/2026"
    i = issues(t)[0]
    assert t[i["start"] : i["end"]] == "31/2/2026"


def test_api_endpoints(client: TestClient):
    r = client.post("/api/legal/check-refs", json={"text": "بتاريخ 31/2/2026"})
    assert r.status_code == 200 and r.json()["issues"][0]["rule"] == "date_impossible"
    c = client.post("/api/legal/case-card", json={"text": "الدعوى رقم 624 لسنة 2026 مدني كلي"})
    assert c.status_code == 200
    assert c.json()["fields"][0]["value"] == "624 لسنة 2026"


def test_article_with_merged_prefix_is_found():
    assert "article_malformed" in rules("وفقا للمادة ( 3 / 1 ) من القانون")
