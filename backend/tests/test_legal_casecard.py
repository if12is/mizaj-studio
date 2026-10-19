"""Case data card extractor («بطاقة القضية»): positive and negative cases.

Fixture sentences imitate the *patterns* of the owner memo (headers, party blocks, relief) and are
written here on purpose: the private document itself is never committed.
"""

import pytest

from app.legal.casecard import extract_case_card
from app.legal.scan import Folded, find_dates


def card(text: str) -> dict:
    return {f["key"]: f for f in extract_case_card(text)["fields"]}


def val(text: str, key: str):
    return card(text).get(key, {}).get("value")


# ------------------------------------------------------------------ case number
@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("الدعوى رقم 624 لسنة 2026 مدني كلي", "624 لسنة 2026"),
        ("الدعوى رقم ٦٢٤ لسنة ٢٠٢٦ مدنى كلى", "624 لسنة 2026"),  # Arabic-Indic digits, ى
        ("الدعوي رقم 624 لسنه 2026", "624 لسنة 2026"),  # ي / ه spellings
        ("الدعوى رقم 624/2026", "624 لسنة 2026"),
        ("الطعن رقم 5517 لسنة 70 ق", "5517 لسنة 70 ق"),
        ("الطعن رقم 5517 لسنة 70 قضائية", "5517 لسنة 70 ق"),
        ("في القضية رقم 12 لسنة 2024 جنح", "12 لسنة 2024"),
        ("الاستئناف رقم 1500 لسنة 142 ق", "1500 لسنة 142 ق"),
        ("بالدعوى المدنية الكلية رقم 77 لسنة 2025", "77 لسنة 2025"),
        ("الدَّعْوَى رَقْم 9 لِسَنَة 2023", "9 لسنة 2023"),  # diacritics
        ("الدعوى رقم 8 لسنة 2024 ، وبجلسة", "8 لسنة 2024"),
        ("الجنحة رقم 3301 لسنة 2025", "3301 لسنة 2025"),
        ("الاشكال رقم 14 لسنة 2025", "14 لسنة 2025"),
        ("الدعوى رقم ۶۲۴ لسنة ۲۰۲۶", "624 لسنة 2026"),  # Persian digits
    ],
)
def test_case_number_positive(text, want):
    assert val(text, "case_number") == want


@pytest.mark.parametrize(
    "text",
    [
        "القانون رقم 90 لسنة 1944",
        "الدعوى بموجب القانون رقم 90 لسنة 1944 المعدل",
        "المطالبة رقم 175 ليكون الإجمالي 374906 جنيه",
        "قرار وزير العدل رقم 12 لسنة 2020",
        "المادة رقم 5 من القانون",
        "",
        "نص عادي بلا أي أرقام للقضايا",
        "اللائحة رقم 3 لسنة 2019",
    ],
)
def test_case_number_negative(text):
    assert "case_number" not in card(text)


def test_case_number_position_and_confidence():
    t = "مقدمة\nفي الدعوى رقم 624 لسنة 2026 مدني كلي"
    f = card(t)["case_number"]
    assert t[f["start"] : f["end"]] == "الدعوى رقم 624 لسنة 2026"
    assert f["confidence"] >= 0.9
    assert f["year"] == 2026 and f["number"] == 624


def test_case_number_prefers_header_over_precedent():
    t = (
        "الدعوى رقم 624 لسنة 2026 مدني كلي\n" + "نص " * 300 + "\n"
        "وقضت محكمة النقض في الطعن رقم 5517 لسنة 70 ق بأن"
    )
    c = card(t)
    assert c["case_number"]["value"] == "624 لسنة 2026"
    other = extract_case_card(t)["other_case_refs"]
    assert [o["text"] for o in other] == ["5517 لسنة 70 ق"]


def test_case_number_two_digit_year_without_q_is_less_certain():
    a = card("الدعوى رقم 12 لسنة 2025")["case_number"]["confidence"]
    b = card("الدعوى رقم 12 لسنة 25")["case_number"]["confidence"]
    assert b < a


def test_case_number_occurrences():
    t = "الدعوى رقم 624 لسنة 2026\nو بالدعوى رقم 624 لسنة 2026 سالفة الذكر"
    assert len(card(t)["case_number"]["occurrences"]) == 2


# ------------------------------------------------------------------ type
@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("الدعوى رقم 624 لسنة 2026 مدني كلي", "مدني كلي"),
        ("الدعوى رقم 624 لسنة 2026 مدنى كلى أبوحمص", "مدنى كلى"),
        ("الدعوى رقم 5 لسنة 2025 مدني جزئي", "مدني جزئي"),
        ("الدعوى رقم 5 لسنة 2025 جنح مستأنف", "جنح مستأنف"),
        ("القضية رقم 5 لسنة 2025 جنح", "جنح"),
        ("الدعوى رقم 5 لسنة 2025 تجاري كلي", "تجاري كلي"),
        ("الدعوى رقم 5 لسنة 2025 اقتصادي", None),
        ("الاستئناف رقم 5 لسنة 2025", "استئناف"),
        ("الطعن رقم 5517 لسنة 70 ق", "طعن"),
        ("الدعوى المدنية رقم 5 لسنة 2025", "المدنية"),
    ],
)
def test_case_type(text, want):
    got = val(text, "case_type")
    if want is None:
        assert got is None
    else:
        assert got is not None and want in got or got == want


def test_case_type_not_taken_from_prose():
    assert "case_type" not in card("ارتكب المتهم جنحة سرقة وفق القانون المدني")


# ------------------------------------------------------------------ court / circuit
@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("محكمة أبو حمص الكلية", "محكمة أبو حمص الكلية"),
        ("محكمة ابو حمص الكلية", "محكمة ابو حمص الكلية"),  # missing hamza
        ("أمام محكمة النقض الدائرة المدنية", "محكمة النقض"),
        ("بمحكمة الجيزة الابتدائية", "محكمة الجيزة الابتدائية"),
        ("محكمة استئناف القاهرة الدائرة الخامسة", "محكمة استئناف القاهرة"),
        ("محكمة القضاء الإداري", "محكمة القضاء الإداري"),
        ("محكمة شمال القاهرة الابتدائية", "محكمة شمال القاهرة الابتدائية"),
        ("المحكمة الإدارية العليا", None),
        ("وقضت المحكمة بقبول الدعوى", None),
        ("لا شيء هنا", None),
    ],
)
def test_court(text, want):
    assert val(text, "court") == want


def test_court_header_beats_precedent_mention():
    t = "محكمة أبو حمص الكلية\n" + "ن " * 100 + "\nوحكمت محكمة النقض بأن كذا"
    assert val(t, "court") == "محكمة أبو حمص الكلية"


def test_court_stops_before_circuit_and_date():
    assert (
        val("محكمة الجيزة الكلية الدائرة الثالثة جلسة 1/1/2026", "court") == "محكمة الجيزة الكلية"
    )


@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("الدائرة الثالثة مدني كلي", "الدائرة الثالثة مدني كلي"),
        ("الدائرة الرابعة", "الدائرة الرابعة"),
        ("الدائرة (5) إيجارات", "الدائرة 5 إيجارات"),
        ("الدائرة 12 مدني", "الدائرة 12 مدني"),
        ("أمام الدائرة الأولى مدني في جلسة", "الدائرة الأولى مدني"),
        ("الدائرة الثالثة والمنعقدة", "الدائرة الثالثة"),
    ],
)
def test_circuit(text, want):
    got = val(text, "circuit")
    assert got is not None and got.replace("(", "").replace(")", "") == want or got == want


def test_circuit_absent():
    assert "circuit" not in card("نص بلا ذكر لدائرة")
    assert "circuit" not in card("الدائرة في جلسة")


# ------------------------------------------------------------------ sessions
@pytest.mark.parametrize(
    ("text", "want"),
    [
        ("المحدد لنظرها جلسة 30/7/2026", ["30/7/2026"]),
        ("لجلسة ٣٠/٧/٢٠٢٦", ["٣٠/٧/٢٠٢٦"]),  # original spelling is kept
        ("بجلسة 2026/7/30", ["2026/7/30"]),
        ("لجلسة يوم الخميس الموافق 30-7-2026", ["30-7-2026"]),
        ("جلسة 30 يوليو 2026", ["30 يوليو 2026"]),
        ("بجلسة 1/2/2026 وتأجلت لجلسة 3/4/2026", ["1/2/2026", "3/4/2026"]),
        ("وحددت جلسة المرافعة 30.7.2026", ["30.7.2026"]),
    ],
)
def test_sessions(text, want):
    f = card(text)["session_dates"]
    assert [i["text"] for i in f["items"]] == want


def test_session_iso_and_validity():
    f = card("جلسة 30/7/2026 وجلسة 31/2/2026")["session_dates"]
    assert f["items"][0]["iso"] == "2026-07-30" and f["items"][0]["valid"]
    assert f["items"][1]["iso"] is None and not f["items"][1]["valid"]
    assert f["items"][1]["confidence"] < f["items"][0]["confidence"]


@pytest.mark.parametrize(
    "text",
    [
        "صدر الحكم بتاريخ 30/7/2026",  # a date, but not a session
        "جلسة بلا تاريخ",
        "تحدد جلسة قريبة",
        "الجلسة الأولى مؤجلة",
    ],
)
def test_sessions_negative(text):
    assert "session_dates" not in card(text)


def test_session_position():
    t = "المحدد لنظرها جلسة 30/7/2026"
    i = card(t)["session_dates"]["items"][0]
    assert t[i["start"] : i["end"]] == "30/7/2026"


# ------------------------------------------------------------------ parties
def parties(text):
    f = card(text).get("parties")
    return f["items"] if f else []


def test_party_label_lines():
    t = "المدعي: أحمد محمد علي المقيم بالقاهرة\nالمدعى عليه: شركة الأمل للتجارة"
    p = parties(t)
    assert [(i["role"], i["name"]) for i in p] == [
        ("المدعي", "أحمد محمد علي"),
        ("المدعى عليه", "شركة الأمل للتجارة"),
    ]


def test_party_with_basifa_capacity_label():
    p = parties("المدعى عليه الأول: محافظ البحيرة بصفته الممثل القانوني للمحافظة")
    assert p[0]["role"] == "المدعى عليه"
    assert p[0]["name"] == "محافظ البحيرة"
    assert p[0]["capacity"] == "الممثل القانوني للمحافظة"


def test_party_name_first_basifa_with_role():
    p = parties("السيد/ وزير العدل وآخرين بصفتهم مدعى عليهم")
    assert p and p[0]["role"] == "المدعى عليه"
    assert p[0]["name"] == "وزير العدل وآخرين"


def test_party_basifa_capacity_then_role():
    p = parties("السيد/ محمود حسن بصفته الممثل القانوني لشركة النور (المدعى عليه الأول)")
    assert p[0]["role"] == "المدعى عليه"
    assert p[0]["name"] == "محمود حسن"
    assert "الممثل القانوني" in p[0]["capacity"]


@pytest.mark.parametrize(
    ("line", "role"),
    [
        ("الطاعن: شركة النيل", "الطاعن"),
        ("المطعون ضده: وزير المالية بصفته", "المطعون ضده"),
        ("المستأنف: خالد سعيد", "المستأنف"),
        ("المستأنف ضده: منى أحمد", "المستأنف ضده"),
        ("المتهم: عمر فاروق", "المتهم"),
        ("1- المدعي / كريم عادل", "المدعي"),
        ("المعارض: سمير نبيل", "المعارض"),
        ("المدعيه: هدى محمود", "المدعي"),
    ],
)
def test_party_roles(line, role):
    p = parties(line)
    assert p and p[0]["role"] == role


def test_party_name_on_next_line():
    p = parties("المدعي:\nأحمد محمد علي\nالمدعى عليه:\nشركة الأمل")
    assert [i["name"] for i in p] == ["أحمد محمد علي", "شركة الأمل"]


def test_party_honorific_removed_and_residence_cut():
    p = parties("المدعي: السيد/ أحمد محمد علي ومقيم بالعنوان كذا")
    assert p[0]["name"] == "أحمد محمد علي"


@pytest.mark.parametrize(
    "text",
    [
        "أقام المدعي الدعوى الماثلة بموجب صحيفة",  # prose, no label
        "ورفع المدعي بصفته دعواه",  # basifa without role or honorific
        "دفع المدعى عليه بعدم القبول",
        "نص عادي",
    ],
)
def test_party_negative(text):
    assert parties(text) == []


def test_party_positions_point_at_name():
    t = "المدعي: أحمد محمد علي"
    i = parties(t)[0]
    assert t[i["start"] : i["end"]] == "أحمد محمد علي"


# ------------------------------------------------------------------ relief
def test_relief_heading():
    t = "الوقائع\nكذا وكذا\nالطلبات\nأولا: الحكم بإلغاء أمر التقدير.\nثانيا: المصروفات.\nوكيل المدعي\nالأستاذ فلان"  # noqa: E501
    f = card(t)["relief"]
    assert "الحكم بإلغاء أمر التقدير" in f["value"]
    assert "المصروفات" in f["value"]
    assert "وكيل" not in f["value"]
    assert f["confidence"] >= 0.9


def test_relief_heading_with_colon_same_line():
    t = "الطلبات: الحكم بعدم قبول الدعوى."
    assert val(t, "relief") == "الحكم بعدم قبول الدعوى."


def test_relief_binaa_alayhi():
    t = "وحيث إن الدعوى غير مقبولة\nبناءً عليه يلتمس المدعى عليه الحكم برفض الدعوى مع إلزام المدعي بالمصروفات"  # noqa: E501
    f = card(t)["relief"]
    assert f is not None and "رفض الدعوى" in f["value"] and f["confidence"] < 0.9


def test_relief_lithalek():
    assert "رفض" in val("وفي الموضوع\nلذلك نطلب الحكم برفض الدعوى", "relief")


def test_relief_absent():
    assert "relief" not in card("لا طلبات هنا فقط وقائع عن العقد")
    assert "relief" not in card("بناء عليه")  # heading with no body


def test_relief_takes_last_heading():
    t = "الطلبات\nالأولى\n" + "حشو " * 50 + "\nالطلبات الختامية:\nالحكم بالرفض"
    assert val(t, "relief") == "الحكم بالرفض"


# ------------------------------------------------------------------ whole document
OWNER_STYLE_MEMO = """محكمة أبو حمص الكلية
الدائرة الثالثة مدني كلي
مذكرة بدفاع
المدعى عليهم
في الدعوى رقم 216 لسنة 2025 مدنى كلى أبوحمص
المحدد لنظرها جلسة 30/7/2026
المدعي: شركة الأمل للمقاولات
السيد/ وزير العدل وآخرين بصفتهم مدعى عليهم
الوقائع
تخلص وجيزها فى أن المدعي أقام الدعوى الماثلة بموجب صحيفة مودعة قلم كتاب المحكمة
الطلبات
بإلغاء أمرى تقدير النسبية بالمطالبة رقم 175 ليكون الإجمالى 374906.25 جنيه
فضلا عن إلزام المدعى عليهم بصفتهم بالمصروفات والأتعاب
"""


def test_full_memo():
    r = extract_case_card(OWNER_STYLE_MEMO)
    keys = [f["key"] for f in r["fields"]]
    assert keys == [
        "case_number",
        "case_type",
        "court",
        "circuit",
        "session_dates",
        "parties",
        "relief",
    ]
    c = {f["key"]: f for f in r["fields"]}
    assert c["case_number"]["value"] == "216 لسنة 2025"
    assert c["court"]["value"] == "محكمة أبو حمص الكلية"
    assert c["session_dates"]["value"] == "30/7/2026"
    assert "المصروفات" in c["relief"]["value"]
    assert [p["role"] for p in c["parties"]["items"]] == ["المدعي", "المدعى عليه"]
    for f in r["fields"]:
        assert 0 < f["confidence"] <= 1
        assert OWNER_STYLE_MEMO[f["start"] : f["end"]].strip()


def test_empty_and_non_arabic():
    assert extract_case_card("")["fields"] == []
    assert extract_case_card("Hello world 12/3/2024")["fields"] == []


def test_does_not_modify_and_handles_big_text():
    big = OWNER_STYLE_MEMO * 200
    r = extract_case_card(big)
    assert r["count"] >= 5


def test_folded_maps_back_to_original():
    t = "جَلْسَة ٣٠/٧/٢٠٢٦"
    F = Folded(t)
    d = find_dates(F)[0]
    s, e = F.span(d.fs, d.fe)
    assert t[s:e] == "٣٠/٧/٢٠٢٦"
