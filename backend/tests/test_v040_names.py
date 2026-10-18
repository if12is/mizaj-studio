"""Name handling: redaction spans stop at function words; علي the name is not «على»."""

from __future__ import annotations

import pytest
from test_proofread import run

from app.legal import redact as rdc


def _names(text: str) -> list[str]:
    return [e["original"] for e in rdc.redact(text, ["name"])["edits"]]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("حضر السيد أحمد محمد بأن المبلغ مستحق", ["أحمد محمد"]),
        ("أقر المدعو سامي حسن لأن العقد باطل", ["سامي حسن"]),
        ("تقدم الأستاذ كريم فؤاد كما طلب", ["كريم فؤاد"]),
        ("وكيل السيد يوسف خالد ثم حضر", ["يوسف خالد"]),
        ("أفاد السيد محمود حسن وقد سلم المستندات", ["محمود حسن"]),
        ("السيد هشام عادل ولكن لم يحضر", ["هشام عادل"]),
        ("السيد منصور فيما بعد", ["منصور"]),
        ("السيد ياسر عند المحكمة", ["ياسر"]),
    ],
)
def test_name_span_stops_at_function_words(text, expected):
    assert _names(text) == expected


def test_name_with_connectors_is_kept_whole():
    assert _names("السيد/ محمد بن عبد الله السيد") == ["محمد بن عبد الله"]
    assert _names("حضر السيد أم كلثوم إبراهيم") == ["أم كلثوم إبراهيم"]


def test_function_word_right_after_title_gives_no_name():
    assert _names("السيد بأن") == []


# ------------------------------------------------------------------ علي the name
def _items(text: str) -> list:
    return run(text, "standard", ("ya",))["items"]


@pytest.mark.parametrize(
    "text",
    [
        "حضر المدعو علي أمام المحكمة",
        "المحامي علي أقر بذلك",
        "قال السيد علي إن الأمر كذلك",
        "حضرت السيدة علي هنا",
        "حضر الأستاذ علي",
        "أفاد المستشار علي بالحكم",
        "الدكتور علي حضر",
        "محمد علي حضر",
        "حضر أحمد علي أمس",
        "علي محمد حضر الجلسة",
        "علي أحمد قال ذلك",
        "السيد/ علي أقر",
        "والسيد علي أقر",
    ],
)
def test_name_ali_is_not_changed(text):
    assert [i for i in _items(text) if i["original"] == "علي"] == []


def test_preposition_ali_still_corrected():
    assert any(i["replacement"] == "على" for i in _items("حكمت المحكمة علي المدعى عليه"))
    assert any(i["replacement"] == "على" for i in _items("علي من ألزمه الحكم"))
