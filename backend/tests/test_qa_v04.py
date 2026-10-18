"""v0.4 QA regressions (docs/qa/v0.4-qa-report.md)."""

from __future__ import annotations

import re

import pytest

from app.resources import net


@pytest.mark.parametrize(
    ("reason", "needle"),
    [
        ("HTTP 404", "غير متوفر"),
        ("HTTP 403", "رفض"),
        ("HTTP 503", "مشغول"),
        ("<urlopen error [Errno -2] Name or service not known>", "الاتصال بالإنترنت"),
    ],
)
def test_download_errors_are_specific_arabic(reason, needle):
    err = net._net_error(reason)
    assert needle in err.message_ar
    assert not re.search(r"[A-Za-z]{4,}", err.message_ar.replace("HTTP", ""))
    assert reason in err.message_en  # the raw reason stays in the English/log field only


def test_legal_tool_errors_have_specific_arabic(client):
    from app.api import legal as legal_api

    client.app.include_router(legal_api.router)
    cases = [
        ({"amount": "abc", "currency": "EGP"}, "/api/legal/tafqeet", "رقماً"),
        ({"amount": "-5", "currency": "EGP"}, "/api/legal/tafqeet", "غير سالب"),
        ({"amount": "0", "currency": "EGP"}, "/api/legal/tafqeet", "أكبر من صفر"),
        ({"amount": "9" * 30, "currency": "EGP"}, "/api/legal/tafqeet", "أكبر من الحد"),
        ({"date": "2026-07-30", "calendar": "hijri"}, "/api/legal/date-words", "التقويم"),
        (
            {"date": "2026-02-31", "calendar": "gregorian"},
            "/api/legal/date-words",
            "تاريخ غير صالح",
        ),
    ]
    for body, url, needle in cases:
        r = client.post(url, json=body)
        assert r.status_code == 422, (url, body)
        assert needle in r.json()["message_ar"], r.json()


def test_unsupported_file_type_message(client, tmp_path):
    from app.api import io as io_api

    client.app.include_router(io_api.router)
    f = tmp_path / "x.bin"
    f.write_bytes(b"MZ")
    r = client.post("/api/io/import", json={"path": str(f)})
    assert r.status_code == 422 and "نوع الملف غير مدعوم" in r.json()["message_ar"]
