import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

from app.core.database import connect
from app.core.migrations import MigrationError, run_migrations
from app.main import create_app

BACKEND = Path(__file__).resolve().parent.parent
LATEST = len(list((BACKEND / "app" / "migrations").glob("*.sql")))  # one file per version
ENVELOPE_KEYS = {"error_code", "message_ar", "message_en", "details"}


def mk_project(client, name="P"):
    r = client.post("/api/projects", json={"name": name})
    assert r.status_code == 201
    return r.json()


def mk_doc(client, pid, **kw):
    r = client.post("/api/documents", json={"project_id": pid, "title": "T", **kw})
    assert r.status_code == 201, r.text
    return r.json()


# ---------- health / sidecar ----------
def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    j = r.json()
    models_dir = j.pop("models_dir")
    assert set(j.pop("engines")) == {"fast", "accurate"}
    assert isinstance(models_dir, str) and models_dir.endswith("catt_eo")
    assert j == {
        "status": "ok",
        "version": "0.1.0",
        "engine_mode": "mock",
        "db_user_version": LATEST,
    }


def test_handshake_subprocess(tmp_path):
    env = {**os.environ, "MIZAJ_ENGINE_MODE": "mock"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.main", "--port", "0", "--data-dir", str(tmp_path / "d")],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    try:
        l1 = proc.stdout.readline().strip()
        l2 = proc.stdout.readline().strip()
        assert l1.startswith("MIZAJ_PORT=")
        assert l2 == "MIZAJ_STATUS=READY"
        port = int(l1.split("=")[1])
        assert port > 0
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as resp:
            assert json.load(resp)["status"] == "ok"
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_refuses_non_loopback(tmp_path):
    p = subprocess.run(
        [sys.executable, "-m", "app.main", "--host", "0.0.0.0", "--data-dir", str(tmp_path)],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert p.returncode != 0
    assert "MIZAJ_PORT" not in p.stdout


def test_log_file_created(client):
    assert (client.data_dir / "logs" / "mizaj-backend.log").exists()


# ---------- database / migrations ----------
def test_pragmas_and_wal(data_dir):
    create_app(data_dir)
    conn = connect(data_dir / "mizaj.db")
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("PRAGMA synchronous").fetchone()[0] == 1  # NORMAL
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    conn.close()


def test_schema(data_dir):
    create_app(data_dir)
    conn = connect(data_dir / "mizaj.db")
    assert conn.execute("PRAGMA user_version").fetchone()[0] == LATEST
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"projects", "documents", "tashkeel_cache", "settings", "recent_files"} <= names
    assert {"legal_glossary", "legal_templates"} <= names
    idx = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name='idx_cache_word_unique'"
    ).fetchone()
    assert idx and "UNIQUE" in idx[0].upper()
    conn.close()


def _fake_migrations(tmp_path, second_sql):
    d = tmp_path / "mig"
    d.mkdir()
    for real in sorted((BACKEND / "app" / "migrations").glob("*.sql")):
        (d / real.name).write_text(real.read_text(encoding="utf-8"), encoding="utf-8")
    (d / f"{LATEST + 1:03d}_extra.sql").write_text(second_sql, encoding="utf-8")
    return d


def test_backup_on_upgrade_not_on_fresh(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    create_app(data)  # fresh -> latest, no backup
    assert not (data / "backups").exists() or not list((data / "backups").iterdir())
    mig = _fake_migrations(tmp_path, "CREATE TABLE extra(x INTEGER);")
    # also fresh db with all migrations: no backup
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    assert run_migrations(fresh / "mizaj.db", fresh / "backups", mig) == LATEST + 1
    assert not (fresh / "backups").exists()
    # upgrade existing
    assert run_migrations(data / "mizaj.db", data / "backups", mig) == LATEST + 1
    backups = list((data / "backups").glob(f"mizaj-*-v{LATEST}.db"))
    assert len(backups) == 1
    b = sqlite3.connect(backups[0])
    assert b.execute("PRAGMA user_version").fetchone()[0] == LATEST
    b.close()


def test_migration_failure_rolls_back(tmp_path):
    data = tmp_path / "data"
    data.mkdir()
    create_app(data)
    mig = _fake_migrations(tmp_path, "CREATE TABLE good(x); INSERT INTO nonexistent VALUES (1);")
    with pytest.raises(MigrationError) as ei:
        run_migrations(data / "mizaj.db", data / "backups", mig)
    assert ei.value.error_code == "ERR_DB_MIGRATION_FAILED"
    conn = connect(data / "mizaj.db")
    assert conn.execute("PRAGMA user_version").fetchone()[0] == LATEST
    assert conn.execute("SELECT 1 FROM sqlite_master WHERE name='good'").fetchone() is None
    conn.close()
    with pytest.raises(Exception) as ei2:
        create_app(data, migrations_dir=mig)
    assert getattr(ei2.value, "error_code", None) == "ERR_DB_MIGRATION_FAILED"


# ---------- errors ----------
def test_error_envelope(client):
    r = client.get("/api/projects/999")
    assert r.status_code == 404
    body = r.json()
    assert set(body) == ENVELOPE_KEYS
    assert body["error_code"] == "ERR_NOT_FOUND"
    r = client.post("/api/projects", json={})
    assert r.status_code == 422
    assert set(r.json()) == ENVELOPE_KEYS
    assert r.json()["error_code"] == "ERR_VALIDATION"
    assert client.get("/api/projects/abc").json()["error_code"] == "ERR_VALIDATION"
    assert client.get("/nope").status_code == 404


# ---------- projects ----------
def test_projects_crud(client):
    assert client.get("/api/projects").json() == []
    p = mk_project(client, "A")
    assert set(p) == {"id", "name", "description", "created_at", "updated_at"}
    assert p["description"] == ""
    assert client.get(f"/api/projects/{p['id']}").json() == p
    r = client.put(f"/api/projects/{p['id']}", json={"description": "d"})
    assert r.json()["description"] == "d" and r.json()["name"] == "A"
    r = client.put(f"/api/projects/{p['id']}", json={"name": "B"})
    assert r.json()["name"] == "B" and r.json()["description"] == "d"
    assert client.put(f"/api/projects/{p['id']}", json={"name": "  "}).status_code == 422
    q = mk_project(client, "Z")
    assert [x["id"] for x in client.get("/api/projects").json()] == [q["id"], p["id"]]
    client.put(f"/api/projects/{p['id']}", json={"name": "C"})
    assert client.get("/api/projects").json()[0]["id"] == p["id"]
    assert client.delete(f"/api/projects/{p['id']}").status_code == 204
    assert client.get(f"/api/projects/{p['id']}").status_code == 404
    assert client.delete(f"/api/projects/{p['id']}").status_code == 404


def test_cascade_delete(client):
    p = mk_project(client)
    d = mk_doc(client, p["id"], raw_content="a b")
    client.delete(f"/api/projects/{p['id']}")
    assert client.get(f"/api/documents/{d['id']}").status_code == 404
    conn = connect(client.data_dir / "mizaj.db")
    assert conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 0
    conn.close()


# ---------- documents ----------
def test_documents_crud(client):
    p = mk_project(client)
    d = mk_doc(client, p["id"], raw_content="كتاب  جميل\nجدا")
    assert d["word_count"] == 3
    assert d["language"] == "ar" and d["direction"] == "rtl" and d["is_deleted"] == 0
    assert d["diacritized_content"] == "" and d["source_docx_path"] is None
    got = client.get(f"/api/documents/{d['id']}").json()
    assert got == d
    r = client.put(f"/api/documents/{d['id']}", json={"raw_content": "one two three four"})
    assert r.json()["word_count"] == 4
    r = client.put(f"/api/documents/{d['id']}", json={"diacritized_content": "x", "title": "N"})
    assert r.json()["word_count"] == 4 and r.json()["title"] == "N"
    assert r.json()["diacritized_content"] == "x"
    lst = client.get(f"/api/documents?project_id={p['id']}").json()
    assert len(lst) == 1
    assert "raw_content" not in lst[0] and "diacritized_content" not in lst[0]
    assert lst[0]["word_count"] == 4
    assert client.delete(f"/api/documents/{d['id']}").status_code == 204
    assert client.get(f"/api/documents?project_id={p['id']}").json() == []
    assert client.get(f"/api/documents/{d['id']}").status_code == 404
    conn = connect(client.data_dir / "mizaj.db")
    assert conn.execute("SELECT is_deleted FROM documents").fetchone()[0] == 1
    conn.close()


def test_document_bad_project(client):
    r = client.post("/api/documents", json={"project_id": 12345, "title": "x"})
    assert r.status_code in (404, 422)
    assert set(r.json()) == ENVELOPE_KEYS
    assert client.post("/api/documents", json={"project_id": 1, "title": " "}).status_code == 422
    p = mk_project(client)
    bad = {"project_id": p["id"], "title": "t", "direction": "up"}
    assert client.post("/api/documents", json=bad).status_code == 422


# ---------- settings ----------
DEFAULTS = {
    "engine_mode": "fast",
    "tashkeel_level": "full",
    "editor_font": "Amiri",
    "editor_font_size": "20",
    "colored_diacritics": "true",
    "theme": "dark",
    "ya_style": "standard",
    "proofread_before_tashkeel": "ask",
}


def test_settings(client):
    assert client.get("/api/settings").json() == DEFAULTS
    r = client.put("/api/settings", json={"theme": "light", "editor_font_size": "24"})
    assert r.status_code == 200
    assert r.json() == {**DEFAULTS, "theme": "light", "editor_font_size": "24"}
    assert client.get("/api/settings").json()["theme"] == "light"


@pytest.mark.parametrize(
    "bad",
    [
        {"engine_mode": "turbo"},
        {"tashkeel_level": "x"},
        {"theme": "blue"},
        {"editor_font_size": "11"},
        {"editor_font_size": "49"},
        {"editor_font_size": "abc"},
        {"colored_diacritics": "yes"},
        {"theme": 5},
    ],
)
def test_settings_invalid(client, bad):
    r = client.put("/api/settings", json={**bad})
    assert r.status_code == 422
    assert r.json()["error_code"] == "ERR_VALIDATION"
    assert client.get("/api/settings").json() == DEFAULTS


def test_settings_invalid_is_atomic(client):
    r = client.put("/api/settings", json={"theme": "light", "engine_mode": "bad"})
    assert r.status_code == 422
    assert client.get("/api/settings").json()["theme"] == "dark"


# ---------- dictionary ----------
def add(client, w="كتاب", f="كِتَابٌ"):
    return client.post("/api/dictionary", json={"word_or_phrase": w, "diacritized_form": f})


def test_dictionary_crud(client):
    r = add(client)
    assert r.status_code == 201
    e = r.json()
    assert e["source"] == "user" and e["is_user_locked"] == 1 and e["usage_count"] == 1
    assert set(e) == {
        "id",
        "word_or_phrase",
        "diacritized_form",
        "source",
        "is_user_locked",
        "usage_count",
        "created_at",
        "updated_at",
    }
    add(client, "علم", "عِلْمٌ")
    assert len(client.get("/api/dictionary").json()) == 2
    found = client.get("/api/dictionary", params={"q": "علم"}).json()
    assert [x["word_or_phrase"] for x in found] == ["علم"]
    assert client.get("/api/dictionary", params={"q": "zzz"}).json() == []
    assert client.get("/api/dictionary", params={"q": "%"}).json() == []
    r = client.put(f"/api/dictionary/{e['id']}", json={"diacritized_form": "كِتَابٍ"})
    assert r.json()["diacritized_form"] == "كِتَابٍ"
    assert client.put("/api/dictionary/9999", json={"diacritized_form": "x"}).status_code == 404
    assert client.delete(f"/api/dictionary/{e['id']}").status_code == 204
    assert client.delete(f"/api/dictionary/{e['id']}").status_code == 404
    assert len(client.get("/api/dictionary").json()) == 1


def test_dictionary_rejects_forms_that_change_base_letters(client):
    r = add(client, "كلب", "كِتَابٌ")
    assert r.status_code == 422 and "نفس حروف" in r.json()["message_ar"]
    e = add(client).json()
    r = client.put(f"/api/dictionary/{e['id']}", json={"diacritized_form": "كُتُبٌ"})
    assert r.status_code == 422
    assert client.get("/api/dictionary").json()[0]["diacritized_form"] == "كِتَابٌ"


def test_dictionary_duplicate(client):
    assert add(client).status_code == 201
    r = add(client)
    assert r.status_code == 409
    assert r.json()["error_code"] == "ERR_DUPLICATE_WORD"
    assert set(r.json()) == ENVELOPE_KEYS
    assert (
        client.post(
            "/api/dictionary", json={"word_or_phrase": "", "diacritized_form": "x"}
        ).status_code
        == 422
    )


def test_dictionary_engine_row_upgrade(client):
    conn = connect(client.data_dir / "mizaj.db")
    conn.execute(
        "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form) VALUES ('قلم','قَلَمٌ')"
    )
    conn.close()
    assert client.get("/api/dictionary").json() == []  # engine rows are not dictionary entries
    r = add(client, "قلم", "قَلَمُ")
    assert r.status_code == 201
    assert r.json()["is_user_locked"] == 1 and r.json()["source"] == "user"
    assert r.json()["diacritized_form"] == "قَلَمُ"
    assert add(client, "قلم", "قَلَمٌ").status_code == 409


def test_raw_duplicate_insert_integrity_error(data_dir):
    create_app(data_dir)
    conn = connect(data_dir / "mizaj.db")
    sql = "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form) VALUES ('a','b')"
    conn.execute(sql)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(sql)
    conn.close()


def test_dictionary_import_export_roundtrip(client):
    add(client, "علم", "عِلْمٌ")
    body = {
        "entries": [
            {"word_or_phrase": "علم", "diacritized_form": "عَلَمٌ"},
            {"word_or_phrase": "قلم", "diacritized_form": "قَلَمٌ"},
            {"word_or_phrase": "كلب", "diacritized_form": "كتابٌ"},  # letters differ: rejected
        ]
    }
    r = client.post("/api/dictionary/import", json=body)
    assert r.status_code == 200
    assert r.json() == {"imported": 1, "updated": 1, "rejected": 1}
    exp = client.get("/api/dictionary/export").json()
    assert exp["version"] == 1
    assert {(e["word_or_phrase"], e["diacritized_form"]) for e in exp["entries"]} == {
        ("علم", "عَلَمٌ"),
        ("قلم", "قَلَمٌ"),
    }
    for e in client.get("/api/dictionary").json():
        client.delete(f"/api/dictionary/{e['id']}")
    r = client.post("/api/dictionary/import", json=exp)
    assert r.json() == {"imported": 2, "updated": 0, "rejected": 0}
    assert client.get("/api/dictionary/export").json()["entries"] == exp["entries"]


def test_cors_allows_local_renderer_origins(client):
    for origin in ("null", "http://localhost:5173", "http://127.0.0.1:5173"):
        r = client.get("/health", headers={"Origin": origin})
        assert r.headers.get("access-control-allow-origin") == origin
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in r.headers


def _start_sidecar(tmp_path, *extra, env_extra=None):
    env = {**os.environ, "MIZAJ_ENGINE_MODE": "mock", **(env_extra or {})}
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "app.main",
            "--port",
            "0",
            "--data-dir",
            str(tmp_path / "d"),
            *extra,
        ],
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert proc.stdout.readline().startswith("MIZAJ_PORT=")
    assert proc.stdout.readline().strip() == "MIZAJ_STATUS=READY"
    return proc


def _dummy_parent():
    return subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])


@pytest.mark.parametrize("via_env", [False, True])
def test_sidecar_exits_when_parent_dies(tmp_path, via_env):
    dummy = _dummy_parent()
    if via_env:
        proc = _start_sidecar(tmp_path, env_extra={"MIZAJ_PARENT_PID": str(dummy.pid)})
    else:
        proc = _start_sidecar(tmp_path, "--parent-pid", str(dummy.pid))
    try:
        time.sleep(1.5)
        assert proc.poll() is None  # parent alive -> keeps running
        dummy.kill()
        dummy.wait()
        t0 = time.time()
        proc.wait(timeout=8)
        assert time.time() - t0 < 6
    finally:
        for p in (dummy, proc):
            if p.poll() is None:
                p.kill()


def test_sidecar_without_parent_pid_keeps_running(tmp_path):
    proc = _start_sidecar(tmp_path)
    try:
        time.sleep(2)
        assert proc.poll() is None
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_db_dependency_survives_thread_hops(client):
    """Regression: sync dependency and endpoint may run on different threads (500 before)."""
    from concurrent.futures import ThreadPoolExecutor

    def hit(_):
        return client.get("/api/settings").status_code, client.get("/health").status_code

    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(hit, range(200)))
    assert all(r == (200, 200) for r in results), {r for r in results if r != (200, 200)}
