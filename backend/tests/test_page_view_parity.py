"""Page view == exported file: both come from `stored.apply_stored`, so after any editor edit
(find & replace, rewritten / added / removed lines) the render shows exactly the export text."""

from __future__ import annotations

import html as htmllib
import os
import re
from pathlib import Path

import pytest

from app.docx.render import render_docx
from app.docx.service import extract_plain_text

FIXTURE = Path(__file__).parent / "fixtures" / "many_paragraphs.docx"
OWNER = Path(
    os.environ.get(
        "MIZAJ_OWNER_DOCX",
        "/tmp/claude-0/-home-user/25e2b210-8bc8-5825-aad7-9b5f2b792bc6/scratchpad/doc/in.docx",
    )
)


def _visible(html: str) -> list[str]:
    s = re.sub(r"</(p|tr)>", "\n", html)
    s = re.sub(r"</td>", "\n", s)
    s = htmllib.unescape(re.sub(r"<[^>]+>", "", s)).replace("​", "")
    return [ln for ln in (x.strip() for x in s.split("\n")) if ln]


def _lines(text: str) -> list[str]:
    return [ln for ln in (x.strip() for x in text.split("\n")) if ln]


def _import(client, src):
    pid = client.post("/api/projects", json={"name": "P"}).json()["id"]
    r = client.post("/api/docx/import", json={"path": str(src), "project_id": pid})
    return r.json()["document_id"]


def _render(client, did, diacritized):
    r = client.post("/api/docx/render", json={"document_id": did, "diacritized": diacritized})
    assert r.status_code == 200, r.text
    return r.json()


def _export_lines(client, did, out):
    r = client.post("/api/docx/export", json={"document_id": did, "target_path": str(out)})
    assert r.status_code == 200, r.text
    text, _ = extract_plain_text(out)
    return _lines(text), r.json()["stats"]


def _check_parity(client, did, tmp_path, diacritized, expect=None):
    res = _render(client, did, diacritized)
    exported, stats = _export_lines(client, did, tmp_path / "o.docx")
    assert _visible(res["html"]) == exported
    if expect is not None:
        assert exported == expect
    assert "skipped" not in (res["stats"]["diacritics"] or {})
    return res, stats


def test_find_replace_on_many_paragraphs_renders_editor_text(client, tmp_path):
    did = _import(client, FIXTURE)
    raw = client.get(f"/api/documents/{did}").json()["raw_content"]
    edited = raw.replace("الكتاب", "الكِتَابُ").replace("جميل", "رائع")  # marks + letters
    assert edited.count("رائع") >= 60
    client.put(f"/api/documents/{did}", json={"raw_content": edited, "diacritized_content": edited})
    res, stats = _check_parity(client, did, tmp_path, True, _lines(edited))
    assert res["stats"]["diacritics"]["applied"] >= 60
    assert res["stats"]["diacritics"]["added"] == 0
    assert stats["engine_fallback"] == 0
    assert "جميل" not in res["html"]


def test_raw_edit_without_diacritized_renders_edit_and_matches_letters(client, tmp_path):
    did = _import(client, FIXTURE)
    raw = client.get(f"/api/documents/{did}").json()["raw_content"].replace("جميل", "رائع")
    client.put(f"/api/documents/{did}", json={"raw_content": raw})
    res = _render(client, did, False)
    assert _visible(res["html"]) == _lines(raw)  # the edit shows in the view, no stale original
    exported, _ = _export_lines(client, did, tmp_path / "o.docx")  # export adds engine marks
    strip = re.compile("[ً-ْٰ]")
    assert [strip.sub("", x) for x in exported] == [strip.sub("", x) for x in _lines(raw)]


def test_added_removed_and_rewritten_lines_match_export(client, tmp_path):
    did = _import(client, FIXTURE)
    lines = client.get(f"/api/documents/{did}").json()["raw_content"].split("\n")
    lines[3] = "نَصٌّ جَدِيدٌ مُخْتَلِفٌ تَمَامًا عَنِ الأَصْلِ"  # rewritten
    del lines[10]  # removed
    lines.insert(20, "فقرة مضافة من المحرر")  # added mid-document
    lines.insert(0, "عنوان مضاف في الأول")  # added first
    lines.append("خاتمة مضافة")  # added last
    stored = "\n".join(lines)
    client.put(f"/api/documents/{did}", json={"diacritized_content": stored})
    res, stats = _check_parity(client, did, tmp_path, True, _lines(stored))
    assert stats["added_paragraphs"] == 3 and stats["removed_paragraphs"] == 1
    assert res["stats"]["diacritics"]["added"] == 3
    assert res["stats"]["diacritics"]["removed"] == 1


def test_render_unit_level_no_skips_after_mass_replace(tmp_path):
    text, _ = extract_plain_text(FIXTURE)
    edited = text.replace("الكتاب", "الكِتَابُ").replace("جميل", "رائع")
    res = render_docx(FIXTURE, edited)
    d = res["stats"]["diacritics"]
    assert d["kept"] == 0 and "skipped" not in d
    assert _visible(res["html"]) == _lines(edited)


@pytest.mark.skipif(not OWNER.is_file(), reason="owner document not available")
def test_owner_document_after_find_replace(client, tmp_path):
    did = _import(client, OWNER)
    raw = client.get(f"/api/documents/{did}").json()["raw_content"]
    words = re.findall(r"[ء-ي]{4,}", raw)
    target = max(set(words), key=words.count)
    edited = raw.replace(target, target + "ـة")
    client.put(f"/api/documents/{did}", json={"raw_content": edited, "diacritized_content": edited})
    res = _render(client, did, True)
    exported, stats = _export_lines(client, did, tmp_path / "o.docx")
    # list numbering / bullets are drawn by the view
    label = re.compile(r"^(?:(?:\d+|[\u0621-\u064a])\s?[-.)]|\u2022)\s*")
    assert [label.sub("", x) for x in _visible(res["html"])] == exported == _lines(edited)
    assert res["stats"]["diacritics"]["kept"] == 0 and stats["engine_fallback"] == 0


def test_paragraph_with_code_runs_takes_marks_and_keeps_code(client, tmp_path):
    src = Path(__file__).parent / "fixtures" / "sample_mixed.docx"
    did = _import(client, src)
    raw = client.get(f"/api/documents/{did}").json()["raw_content"]
    marked = raw.replace("اشتريت", "اِشْتَرَيْتُ")
    client.put(f"/api/documents/{did}", json={"diacritized_content": marked})
    res, stats = _check_parity(client, did, tmp_path, True, _lines(marked))
    assert "iPhone 16 Pro" in res["html"] and "اِشْتَرَيْتُ" in res["html"]
    assert res["stats"]["diacritics"]["kept"] == 0 and stats["engine_fallback"] == 0
