"""Full-text search across documents: Arabic normalization, snippets, index upkeep."""

from __future__ import annotations

import sqlite3

import pytest

from app.core import search as fts
from app.main import create_app


def test_normalize_folds_variants():
    assert fts.normalize("مُدَرِّسَةٌ") == "مدرسه"
    assert fts.normalize("أحمد إبراهيم آمن") == "احمد ابراهيم امن"
    assert fts.normalize("كــتــاب") == "كتاب"
    assert fts.normalize("على") == fts.normalize("علي")
    assert fts.normalize("مسؤول") == "مسوول"
    assert fts.normalize("١٢٣ ABC") == "123 abc"


def test_positions_map_back_to_original():
    text = "مُدَرِّسَةٌ جميلة"
    norm = fts.normalize(text)
    pos = fts.positions(text)
    assert len(pos) == len(norm)
    assert text[pos[0]] == "م"
    assert text[pos[norm.index("جميله")]] == "ج"


@pytest.fixture
def docs(client):
    pid = client.post("/api/projects", json={"name": "قضية العمل"}).json()["id"]
    other = client.post("/api/projects", json={"name": "مشروع آخر"}).json()["id"]

    def mk(project, title, body):
        r = client.post(
            "/api/documents", json={"project_id": project, "title": title, "raw_content": body}
        )
        assert r.status_code == 201
        return r.json()["id"]

    return {
        "pid": pid,
        "other": other,
        "a": mk(pid, "مذكرة دفاع", "ذهب المُدَرِّسُ إلى المَدْرَسَةِ ثم عاد إلى البيت."),
        "b": mk(other, "رسالة", "أحمد كتب الرسالة\r\nوأرسلها إلى المدرسة القريبة من البيت."),
        "c": mk(pid, "ملاحظات", "لا علاقة لهذا النص بالموضوع."),
    }


def search(client, q, **params):
    r = client.get("/api/search", params={"q": q, **params})
    assert r.status_code == 200, r.text
    return r.json()


def test_search_ignores_diacritics_and_variants(client, docs):
    res = search(client, "مدرسة")
    assert {r["document_id"] for r in res["results"]} == {docs["a"], docs["b"]}
    res = search(client, "مَدْرَسَه")  # ha instead of ta marbuta, with marks
    assert {r["document_id"] for r in res["results"]} == {docs["a"], docs["b"]}
    assert {r["document_id"] for r in search(client, "احمد")["results"]} == {docs["b"]}
    assert {r["document_id"] for r in search(client, "أحمد")["results"]} == {docs["b"]}
    assert search(client, "غير موجود")["results"] == []


def test_search_matches_all_words_and_prefix(client, docs):
    assert {r["document_id"] for r in search(client, "المدرسة البيت")["results"]} == {
        docs["a"],
        docs["b"],
    }
    assert {r["document_id"] for r in search(client, "مدرسة احمد")["results"]} == {docs["b"]}
    assert {r["document_id"] for r in search(client, "مدرس")["results"]} == {docs["a"], docs["b"]}
    assert search(client, "")["results"] == []
    assert search(client, "م")["results"] == []  # too short to be useful


def test_search_title_and_project_filter(client, docs):
    res = search(client, "مذكره")
    assert [r["document_id"] for r in res["results"]] == [docs["a"]]
    assert res["results"][0]["title_ranges"] == [[0, 5]]
    assert res["results"][0]["project_name"] == "قضية العمل"
    only = search(client, "مدرسة", project_id=docs["other"])
    assert [r["document_id"] for r in only["results"]] == [docs["b"]]


def test_snippet_highlights_original_text_and_offsets(client, docs):
    res = search(client, "مدرسة")
    a = next(r for r in res["results"] if r["document_id"] == docs["a"])
    sn = a["snippets"][0]
    s, e = sn["ranges"][0]
    assert sn["text"][s:e] == "المَدْرَسَةِ"  # original text, trailing mark included
    assert "درس" in fts.normalize(sn["text"][s:e])
    body = "ذهب المُدَرِّسُ إلى المَدْرَسَةِ ثم عاد إلى البيت."
    # offset points at the match start inside the document (editor coordinates)
    assert fts.normalize(body[sn["offset"] :]).startswith("المدرسه")
    # CRLF counts once, as CodeMirror does
    b = next(r for r in res["results"] if r["document_id"] == docs["b"])
    text_b = "أحمد كتب الرسالة\nوأرسلها إلى المدرسة القريبة من البيت."
    off = b["snippets"][0]["offset"]
    assert fts.normalize(text_b[off:]).startswith("المدرسه")
    assert b["match_count"] >= 1


def test_index_follows_edits_and_deletes(client, docs):
    client.put(f"/api/documents/{docs['c']}", json={"raw_content": "نص جديد عن الاستئناف"})
    assert [r["document_id"] for r in search(client, "الاستئناف")["results"]] == [docs["c"]]
    assert search(client, "علاقة")["results"] == []  # old text is gone
    client.put(f"/api/documents/{docs['c']}", json={"title": "عنوان فريد"})
    assert [r["document_id"] for r in search(client, "فريد")["results"]] == [docs["c"]]
    assert client.delete(f"/api/documents/{docs['c']}").status_code == 204
    assert search(client, "الاستئناف")["results"] == []
    # deleting a project hides its documents too
    client.delete(f"/api/projects/{docs['other']}")
    assert search(client, "احمد")["results"] == []


def test_startup_indexes_documents_that_predate_the_index(data_dir):
    app = create_app(data_dir)
    db = data_dir / "mizaj.db"
    conn = sqlite3.connect(str(db))
    conn.execute("INSERT INTO projects(name) VALUES ('p')")
    conn.execute(
        "INSERT INTO documents(project_id, title, raw_content) VALUES (1, 'قديم', 'محتوى قديم جدا')"
    )
    conn.commit()
    conn.close()
    assert fts.ensure_index(db) == 1
    assert fts.ensure_index(db) == 0  # nothing stale any more
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        res = c.get("/api/search", params={"q": "قديم"}).json()
        assert len(res["results"]) == 1


def test_search_needs_query_and_survives_odd_input(client, docs):
    assert client.get("/api/search").status_code == 422
    for q in ['"', "AND OR NOT", "*", "مدرسة)(", "a" * 200]:
        assert client.get("/api/search", params={"q": q}).status_code == 200
