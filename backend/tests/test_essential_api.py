"""The `essential` tashkeel level is accepted by settings and the tashkeel / docx / io APIs."""

from __future__ import annotations


def test_api_essential_level(client) -> None:
    r = client.put("/api/settings", json={"tashkeel_level": "essential"})
    assert r.status_code == 200 and r.json()["tashkeel_level"] == "essential"
    r = client.post("/api/tashkeel", json={"text": "كتاب جديد", "level": "essential"})
    assert r.status_code == 200 and r.json()["text"] == "كتابُ جديدُ"  # mock mode: no shadda
    assert client.post("/api/tashkeel", json={"text": "x", "level": "bad"}).status_code == 422
