"""Document edit history (سجل التعديلات): snapshots, coalescing, dedupe, retention, restore."""

from __future__ import annotations

import sqlite3
import zlib
from datetime import UTC, datetime, timedelta

import pytest

from app.core import versions as vs


@pytest.fixture
def doc(client):
    pid = client.post("/api/projects", json={"name": "p"}).json()["id"]
    d = client.post(
        "/api/documents", json={"project_id": pid, "title": "t", "raw_content": "بسم الله"}
    ).json()
    return d["id"]


def save(client, did, text):
    r = client.put(f"/api/documents/{did}", json={"raw_content": text})
    assert r.status_code == 200
    return r.json()


def versions(client, did):
    return client.get(f"/api/documents/{did}/versions").json()


def raw_db(client):
    conn = sqlite3.connect(str(client.data_dir / "mizaj.db"))
    conn.row_factory = sqlite3.Row
    return conn


def backdate(client, did, seconds=None, days=None):
    """Move every version of the document into the past."""
    delta = timedelta(seconds=seconds or 0, days=days or 0)
    conn = raw_db(client)
    for r in conn.execute(
        "SELECT id, created_at FROM document_versions WHERE document_id=?", (did,)
    ).fetchall():
        old = datetime.strptime(r["created_at"], "%Y-%m-%dT%H:%M:%S.%fZ") - delta
        conn.execute(
            "UPDATE document_versions SET created_at=? WHERE id=?",
            (old.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", r["id"]),
        )
    conn.commit()
    conn.close()


def test_migration_creates_table(client):
    conn = raw_db(client)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(document_versions)")}
    conn.close()
    assert {"document_id", "kind", "label", "content_z", "words_added", "chars_delta"} <= cols


def test_create_document_records_initial_version(client, doc):
    v = versions(client, doc)
    assert v["total"] == 1
    assert v["items"][0]["kind"] == "initial" and v["items"][0]["label"] == vs.LABEL_CREATED


def test_autosave_records_and_stats(client, doc):
    save(client, doc, "بسم الله الرحمن")
    items = versions(client, doc)["items"]
    assert len(items) == 2
    top = items[0]
    assert top["label"] == "تعديل يدوي" and top["kind"] == "autosave"
    assert top["words_added"] == 1 and top["words_removed"] == 0
    assert top["word_count"] == 3 and top["chars_delta"] == len(" الرحمن")


def test_baseline_kept_for_pre_existing_document(client, doc):
    conn = raw_db(client)
    conn.execute("DELETE FROM document_versions")
    conn.commit()
    conn.close()
    save(client, doc, "بسم الله الرحمن")
    items = versions(client, doc)["items"]
    assert [i["kind"] for i in items] == ["autosave", "initial"]
    assert items[1]["label"] == vs.LABEL_INITIAL


def test_content_is_zlib_compressed(client, doc):
    text = "كلمة " * 5000
    save(client, doc, text)
    conn = raw_db(client)
    row = conn.execute("SELECT content_z FROM document_versions ORDER BY id DESC").fetchone()
    conn.close()
    assert len(row["content_z"]) < len(text.encode()) / 20
    assert zlib.decompress(row["content_z"]).decode() == text
    vid = versions(client, doc)["items"][0]["id"]
    assert client.get(f"/api/documents/{doc}/versions/{vid}").json()["content"] == text


def test_identical_content_is_deduped(client, doc):
    save(client, doc, "بسم الله الرحمن")
    n = versions(client, doc)["total"]
    save(client, doc, "بسم الله الرحمن")
    save(client, doc, "بسم الله الرحمن")
    assert versions(client, doc)["total"] == n


def test_rapid_typing_coalesces_into_one_entry(client, doc):
    for t in ("بسم الله ا", "بسم الله الر", "بسم الله الرحمن", "بسم الله الرحمن الرحيم"):
        save(client, doc, t)
    items = versions(client, doc)["items"]
    assert len(items) == 2  # initial + one coalesced typing entry
    top = items[0]
    assert top["word_count"] == 4 and top["words_added"] == 2  # vs the state before typing
    got = client.get(f"/api/documents/{doc}/versions/{top['id']}").json()
    assert got["content"] == "بسم الله الرحمن الرحيم"


def test_typing_after_30s_starts_a_new_entry(client, doc):
    save(client, doc, "بسم الله الرحمن")
    backdate(client, doc, seconds=45)
    save(client, doc, "بسم الله الرحمن الرحيم")
    items = versions(client, doc)["items"]
    assert len(items) == 3
    assert items[0]["words_added"] == 1 and items[0]["word_count"] == 4


def test_named_event_is_not_merged_and_relabels_identical_autosave(client, doc):
    save(client, doc, "بسم الله الرحمن")
    r = client.post(
        f"/api/documents/{doc}/versions", json={"kind": "event", "label": "قبل التشكيل"}
    )
    assert r.status_code == 201
    items = versions(client, doc)["items"]
    assert len(items) == 2 and items[0]["label"] == "قبل التشكيل" and items[0]["kind"] == "event"
    # tashkeel changes the text; autosave afterwards is a separate entry, never merged into it
    client.post(
        f"/api/documents/{doc}/versions",
        json={"kind": "event", "label": "بعد التشكيل", "content": "بِسْمِ اللَّهِ الرَّحْمَنِ"},
    )
    save(client, doc, "بِسْمِ اللَّهِ الرَّحْمَنِ")  # duplicate of the "after" snapshot
    items = versions(client, doc)["items"]
    assert [i["label"] for i in items[:2]] == ["بعد التشكيل", "قبل التشكيل"]
    assert len(items) == 3
    save(client, doc, "بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ")
    assert versions(client, doc)["items"][0]["kind"] == "autosave"
    assert versions(client, doc)["total"] == 4


def test_event_requires_label(client, doc):
    r = client.post(f"/api/documents/{doc}/versions", json={"kind": "event"})
    assert r.status_code == 422


def test_checkpoint_create_and_label(client, doc):
    r = client.post(
        f"/api/documents/{doc}/versions", json={"kind": "checkpoint", "name": "مسودة أولى"}
    )
    v = r.json()["version"]
    assert v["kind"] == "checkpoint" and v["name"] == "مسودة أولى" and v["label"] == "نقطة استرجاع"
    save(client, doc, "بسم الله الرحمن")
    top = versions(client, doc)["items"][0]
    r = client.put(f"/api/documents/{doc}/versions/{top['id']}", json={"name": "الثانية"})
    assert r.json()["kind"] == "checkpoint" and r.json()["name"] == "الثانية"
    assert client.put(f"/api/documents/{doc}/versions/99999", json={"name": "x"}).status_code == 404


def test_diff_is_word_level(client, doc):
    save(client, doc, "بسم الله الرحمن الرحيم")
    vid = versions(client, doc)["items"][0]["id"]
    backdate(client, doc, seconds=60)
    save(client, doc, "بسم الله العظيم الرحيم و")
    r = client.get(f"/api/documents/{doc}/versions/diff", params={"from": vid})
    d = r.json()
    assert d["to_id"] is None and d["added"] == 2 and d["removed"] == 1
    old = "".join(o["text"] for o in d["ops"] if o["op"] in ("equal", "delete"))
    new = "".join(o["text"] for o in d["ops"] if o["op"] in ("equal", "insert"))
    assert old == "بسم الله الرحمن الرحيم" and new == "بسم الله العظيم الرحيم و"
    assert {"op": "delete", "text": "الرحمن"} in d["ops"]
    assert {"op": "insert", "text": "العظيم"} in d["ops"]


def test_diff_between_two_versions(client, doc):
    save(client, doc, "أ ب ج")
    a = versions(client, doc)["items"][0]["id"]
    backdate(client, doc, seconds=60)
    save(client, doc, "أ ب ج د")
    b = versions(client, doc)["items"][0]["id"]
    d = client.get(f"/api/documents/{doc}/versions/diff", params={"from": a, "to": b}).json()
    assert (d["added"], d["removed"]) == (1, 0) and d["to_id"] == b
    assert (
        client.get(f"/api/documents/{doc}/versions/diff", params={"from": a, "to": "x"}).status_code
        == 422
    )
    assert (
        client.get(f"/api/documents/{doc}/versions/diff", params={"from": 9999}).status_code == 404
    )


def test_diff_unit_whitespace_preserved():
    ops = vs.diff_ops("a  b\nc", "a  x\nc")
    assert "".join(o["text"] for o in ops if o["op"] != "insert") == "a  b\nc"
    assert vs.diff_ops("", "") == []


def test_restore_creates_new_version_and_is_undoable(client, doc):
    save(client, doc, "النص الأول")
    first = versions(client, doc)["items"][0]["id"]
    backdate(client, doc, seconds=60)
    save(client, doc, "النص الثاني بعد التعديل")
    n = versions(client, doc)["total"]
    r = client.post(f"/api/documents/{doc}/versions/{first}/restore", json={})
    assert r.status_code == 200
    body = r.json()
    assert body["content"] == "النص الأول" and body["version"]["kind"] == "restore"
    assert body["version"]["label"].startswith("استعادة نسخة ")
    assert client.get(f"/api/documents/{doc}").json()["raw_content"] == "النص الأول"
    assert versions(client, doc)["total"] == n + 1
    # the pre-restore text is still reachable: restoring it undoes the restore
    prev = versions(client, doc)["items"][1]
    assert (
        client.get(f"/api/documents/{doc}/versions/{prev['id']}").json()["content"]
        == "النص الثاني بعد التعديل"
    )
    r = client.post(
        f"/api/documents/{doc}/versions/{prev['id']}/restore", json={"label": "استعادة نسخة ١٠:٣٠"}
    )
    assert r.json()["version"]["label"] == "استعادة نسخة ١٠:٣٠"
    assert client.get(f"/api/documents/{doc}").json()["raw_content"] == "النص الثاني بعد التعديل"
    # an autosave of the restored text right after is a duplicate
    n = versions(client, doc)["total"]
    save(client, doc, "النص الثاني بعد التعديل")
    assert versions(client, doc)["total"] == n


def test_restore_keeps_unsaved_current_state_in_history(client, doc):
    save(client, doc, "نسخة ب")
    first = versions(client, doc)["items"][-1]["id"]  # the initial one
    r = client.post(f"/api/documents/{doc}/versions/{first}/restore", json={})
    assert r.json()["content"] == "بسم الله"
    texts = [
        client.get(f"/api/documents/{doc}/versions/{i['id']}").json()["content"]
        for i in versions(client, doc)["items"]
    ]
    assert "نسخة ب" in texts


def _seed(client, did, count, *, days_old):
    """Insert `count` plain autosave versions, all `days_old` days in the past."""
    conn = raw_db(client)
    old = datetime.now(UTC) - timedelta(days=days_old)
    ts = old.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    for i in range(count):
        t = f"نص {i}"
        conn.execute(
            "INSERT INTO document_versions(document_id, created_at, updated_at, kind, label, "
            "content_hash, content_z) VALUES (?,?,?,?,?,?,?)",
            (did, ts, ts, "autosave", "تعديل يدوي", f"h{days_old}-{i}", vs.pack(t)),
        )
    conn.commit()
    conn.close()


def test_retention_defaults_keep_recent_and_last_500(client, doc):
    _seed(client, doc, 520, days_old=90)
    save(client, doc, "نص جديد تماما")  # triggers pruning
    # older than 30 days and outside the newest 500: dropped. The just-created initial version is
    # inside the 30-day window, so it stays on top of the 500 newest.
    assert versions(client, doc)["total"] == 501


def test_retention_keeps_everything_within_window(client, doc):
    _seed(client, doc, 40, days_old=5)
    client.put("/api/settings", json={"history_retention_keep": "10"})
    save(client, doc, "نص جديد تماما")
    assert versions(client, doc)["total"] == 42  # all within 30 days: nothing pruned


def test_retention_configurable_and_never_deletes_checkpoints(client, doc):
    r = client.put(
        "/api/settings", json={"history_retention_days": "1", "history_retention_keep": "10"}
    )
    assert r.status_code == 200
    cp = client.post(
        f"/api/documents/{doc}/versions", json={"kind": "checkpoint", "name": "مهم"}
    ).json()
    backdate(client, doc, days=10)
    _seed(client, doc, 30, days_old=10)
    save(client, doc, "نص جديد تماما")
    items = versions(client, doc)["items"]
    ids = {i["id"] for i in items}
    assert cp["version"]["id"] in ids  # old named checkpoint survives
    # 10 newest + the checkpoint (+ the initial one is plain and pruned)
    assert len(items) == 11


def test_retention_setting_validation(client):
    assert client.put("/api/settings", json={"history_retention_days": "0"}).status_code == 422
    assert client.put("/api/settings", json={"history_retention_keep": "abc"}).status_code == 422
    assert client.put("/api/settings", json={"history_retention_keep": "100"}).status_code == 200


def test_versions_deleted_with_document_and_404s(client, doc):
    assert client.get("/api/documents/9999/versions").status_code == 404
    assert client.get(f"/api/documents/{doc}/versions/9999").status_code == 404
    client.delete(f"/api/documents/{doc}")
    assert client.get(f"/api/documents/{doc}/versions").status_code == 404


def test_list_pagination(client, doc):
    for i in range(5):
        save(client, doc, f"نص {i}")
        backdate(client, doc, seconds=60)
    r = client.get(f"/api/documents/{doc}/versions", params={"limit": 2}).json()
    assert len(r["items"]) == 2 and r["total"] >= 5
    nxt = client.get(
        f"/api/documents/{doc}/versions", params={"limit": 2, "before_id": r["items"][-1]["id"]}
    ).json()
    assert nxt["items"][0]["id"] < r["items"][-1]["id"]
