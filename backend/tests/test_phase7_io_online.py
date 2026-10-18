# ruff: noqa: F811, E501
import hashlib
import json
import socket
import stat
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

import pytest
from io_helpers import ioc, set_setting  # noqa: F401

from app.resources import manager, net

BLOB = bytes(range(256)) * 4000  # ~1 MB


class H(BaseHTTPRequestHandler):
    log: list[str] = []

    def log_message(self, *a):
        pass

    def _send(self, code, body: bytes, ctype="application/json", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        H.log.append(self.path)
        if self.path == "/file.bin":
            rng = self.headers.get("Range")
            if rng:
                start = int(rng.split("=")[1].split("-")[0])
                self._send(206, BLOB[start:], "application/octet-stream")
            else:
                self._send(200, BLOB, "application/octet-stream")
        elif self.path == "/v2/languages":
            self._send(200, json.dumps([{"name": "Arabic", "longCode": "ar"}]).encode())
        else:
            self._send(404, b"{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        H.log.append(self.path)
        if self.path == "/v2/check":
            q = parse_qs(body.decode())
            text = q["text"][0]
            off = text.index("الي")
            self._send(200, json.dumps({"matches": [{
                "message": "خطأ", "offset": off + 1, "length": 3, "replacements": [{"value": "إلى"}],
                "rule": {"id": "AR_RULE", "category": {"id": "GRAMMAR"}, "issueType": "grammar"}}]}).encode())  # fmt: skip
        else:
            self._send(404, b"{}")


@pytest.fixture
def server(monkeypatch):
    H.log = []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}"
    monkeypatch.setenv("MIZAJ_LANGUAGETOOL_URL", url)
    yield url
    srv.shutdown()
    manager.set_catalog(None)


def entry(url, **kw):
    return {
        "id": "t1", "name": "T", "kind": "corpus", "url": url + "/file.bin", "filename": "file.bin",
        "sha256": hashlib.sha256(BLOB).hexdigest(), "size": len(BLOB), "license": "CC0",
        "license_url": "http://x", "attribution": "me", **kw,
    }  # fmt: skip


def wait(ioc, jid, path="/api/resources/jobs/"):
    for _ in range(100):
        st = ioc.get(path + jid).json()
        if st["status"] in ("done", "failed", "cancelled"):
            return st
        time.sleep(0.1)
    raise AssertionError(st)


# ------------------------------------------------------------------ 7.8.1 no network when off
def test_no_network_when_switches_off(ioc, monkeypatch, tmp_path):
    calls = []
    real = socket.socket.connect

    def spy(self, addr, *a, **k):
        calls.append(addr)
        raise OSError("network blocked in test")

    monkeypatch.setattr(socket.socket, "connect", spy)
    monkeypatch.setattr(
        socket,
        "create_connection",
        lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(OSError()),
    )
    manager.set_catalog([entry("http://127.0.0.1:9")])
    try:
        st = ioc.get("/api/online/status").json()
        assert st["switches"] == {
            "online_resources": False,
            "online_languagetool": False,
        }
        assert ioc.get("/api/resources").status_code == 200
        r = ioc.post("/api/resources/t1/download", json={"accept_license": True})
        assert r.status_code == 403 and r.json()["error_code"] == "ERR_ONLINE_DISABLED"
        r = ioc.post("/api/tools/languagetool/check", json={"text": "كتاب"})
        assert r.json()["error_code"] == "ERR_ONLINE_DISABLED"
        assert calls == []
    finally:
        monkeypatch.setattr(socket.socket, "connect", real)
        manager.set_catalog(None)


def test_host_allowlist_and_loopback_only():
    from app.core.errors import MizajError

    with pytest.raises(MizajError) as e:
        net.local_request("http://example.com:80", "/x")
    assert e.value.error_code == "ERR_NOT_LOOPBACK"
    assert net.host_allowed("tanzil.net") and not net.host_allowed("evil.example")


def test_download_blocked_host_even_when_enabled(ioc):
    set_setting(ioc, online_resources="true")
    manager.set_catalog([entry("https://evil.example")])
    try:
        r = ioc.post("/api/resources/t1/download", json={"accept_license": True}).json()
        st = wait(ioc, r["job_id"])
        assert st["status"] == "failed" and st["error"]["error_code"] == "ERR_HOST_NOT_ALLOWED"
    finally:
        manager.set_catalog(None)


# ------------------------------------------------------------------ 7.8.3 downloader
def test_download_requires_license_switch_and_verifies(ioc, server):
    manager.set_catalog(
        [
            entry(server),
            entry(server, id="t2", sha256=None),
            entry(server, id="t3", sha256="0" * 64),
        ]
    )
    r = ioc.post("/api/resources/t1/download", json={})
    assert r.json()["error_code"] == "ERR_LICENSE_NOT_ACCEPTED"
    r = ioc.post("/api/resources/t1/download", json={"accept_license": True})
    assert r.json()["error_code"] == "ERR_ONLINE_DISABLED"
    set_setting(ioc, online_resources="true")
    r = ioc.post("/api/resources/t2/download", json={"accept_license": True})
    assert r.json()["error_code"] == "ERR_RESOURCE_NEEDS_FILE"
    jid = ioc.post("/api/resources/t1/download", json={"accept_license": True}).json()["job_id"]
    st = wait(ioc, jid)
    assert st["status"] == "done", st
    f = ioc.data_dir / "resources" / "t1" / "file.bin"
    assert f.read_bytes() == BLOB and st["result"]["license"] == "CC0"
    listing = ioc.get("/api/resources").json()
    assert listing["resources"][0]["installed"]["sha256"] == hashlib.sha256(BLOB).hexdigest()
    # wrong checksum is rejected and leaves no file
    st = wait(
        ioc, ioc.post("/api/resources/t3/download", json={"accept_license": True}).json()["job_id"]
    )
    assert st["status"] == "failed" and st["error"]["error_code"] == "ERR_CHECKSUM_MISMATCH"
    assert not (ioc.data_dir / "resources" / "t3" / "file.bin").exists()
    assert any(
        x["outcome"] == "ok" for x in net.status(ioc.data_dir / "mizaj.db")["recent_requests"]
    )


def test_download_resumes_partial(ioc, server):
    manager.set_catalog([entry(server)])
    set_setting(ioc, online_resources="true")
    d = ioc.data_dir / "resources" / "t1"
    d.mkdir(parents=True)
    (d / "file.bin.part").write_bytes(BLOB[:300_000])
    st = wait(
        ioc, ioc.post("/api/resources/t1/download", json={"accept_license": True}).json()["job_id"]
    )
    assert st["status"] == "done" and (d / "file.bin").read_bytes() == BLOB


def test_import_user_file(ioc, tmp_path):
    manager.set_catalog([entry("http://x", sha256=None)])
    f = tmp_path / "mine.txt"
    f.write_bytes(b"quran text")
    try:
        r = ioc.post(
            "/api/resources/t1/import", json={"path": str(f), "accept_license": True}
        ).json()
        assert (
            r["sha256"] == hashlib.sha256(b"quran text").hexdigest() and r["source"] == "user-file"
        )
    finally:
        manager.set_catalog(None)


def test_catalog_shape():
    manager.set_catalog(None)
    cat = manager.catalog()
    ids = {r["id"] for r in cat}
    assert {"tanzil-quran-uthmani", "ayaspell-ar", "tashkeela-sample", "catt-eo-onnx"} <= ids
    for r in cat:
        assert {
            "name",
            "url",
            "sha256",
            "size",
            "license",
            "license_url",
            "attribution",
            "kind",
        } <= set(r)
        assert r["sha256"] is None or len(r["sha256"]) == 64


# ------------------------------------------------------------------ 7.8.4 / .2 / 7.9.4
def test_tools_discovery(ioc, server, monkeypatch):
    monkeypatch.setenv("MIZAJ_TESSERACT", "/nonexistent")
    monkeypatch.setattr("shutil.which", lambda *_: None)
    j = ioc.get("/api/tools").json()
    assert "ollama" not in j
    assert j["languagetool"]["detected"] and j["languagetool"]["arabic"]
    assert j["tesseract"]["detected"] is False and "Install" in j["tesseract"]["hint"]


def test_ollama_endpoint_removed(ioc):
    assert ioc.post(
        "/api/tools/ollama/suggest", json={"text": "كتاب", "model": "m"}
    ).status_code in (
        404,
        405,
    )


def test_languagetool_maps_to_issue_shape(ioc, server):
    set_setting(ioc, online_languagetool="true")
    text = "ذهب الي المدرسة 😀 غدا"
    r = ioc.post("/api/tools/languagetool/check", json={"text": text}).json()
    i = r["issues"][0]
    assert i["category"] == "grammar" and i["suggestions"] == ["إلى"] and i["code"] == "LT_AR_RULE"
    assert text[i["start"] : i["end"]] == i["word"]
    assert i["start16"] == text.index("الي") + 1 and i["end16"] == i["start16"] + 3


# ------------------------------------------------------------------ 7.3.7 OCR
# Cross-platform fake `tesseract`: a Python script, wrapped in a .cmd on Windows.
FAKE_TESS_PY = r"""
import sys
if len(sys.argv) > 1 and sys.argv[1] == "--list-langs":
    print("List of available languages (2):"); print("ara"); print("eng"); sys.exit(0)
rows = [
    "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext",
    "5\t1\t1\t1\t1\t1\t0\t0\t1\t1\t90.5\t\u0645\u0631\u062d\u0628\u0627",
    "5\t1\t1\t1\t1\t2\t0\t0\t1\t1\t70.5\t\u0628\u0643\u0645",
    "5\t1\t1\t1\t2\t1\t0\t0\t1\t1\t80\t\u0633\u0637\u0631",
]
sys.stdout.buffer.write(("\n".join(rows) + "\n").encode("utf-8"))
"""


def make_fake_tesseract(tmp_path):
    script = tmp_path / "fake_tesseract.py"
    script.write_text(FAKE_TESS_PY, encoding="utf-8")
    if sys.platform == "win32":
        exe = tmp_path / "tesseract.cmd"
        exe.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
    else:
        exe = tmp_path / "tesseract"
        exe.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        exe.chmod(exe.stat().st_mode | stat.S_IEXEC)
    return exe


def test_ocr_missing_tesseract(ioc, monkeypatch, tmp_path):
    monkeypatch.setenv("MIZAJ_TESSERACT", str(tmp_path / "nope"))
    monkeypatch.setattr("shutil.which", lambda *_: None)
    monkeypatch.setattr("app.tools.discovery.WIN_TESSERACT", [])
    img = tmp_path / "a.png"
    img.write_bytes(b"x")
    r = ioc.post("/api/ocr", json={"path": str(img)})
    assert r.status_code == 424 and r.json()["error_code"] == "ERR_OCR_TESSERACT_MISSING"
    assert "tesseract-ocr-ara" in r.json()["message_en"]


def test_ocr_image_and_scanned_pdf(ioc, monkeypatch, tmp_path):
    from PIL import Image

    tess = make_fake_tesseract(tmp_path)
    monkeypatch.setenv("MIZAJ_TESSERACT", str(tess))
    img = tmp_path / "a.png"
    Image.new("RGB", (200, 100), "white").save(img)
    r = ioc.post("/api/ocr", json={"path": str(img)}).json()
    assert r["text"] == "مرحبا بكم\nسطر" and r["confidence"] == 80.3
    pdf = tmp_path / "scan.pdf"
    Image.new("RGB", (300, 400), "white").save(pdf, "PDF")
    r = ioc.post("/api/ocr", json={"path": str(pdf), "dpi": 100}).json()
    assert r["pages"][0]["method"] == "ocr" and "مرحبا" in r["text"]
    monkeypatch.setattr("app.tools.discovery.tesseract_languages", lambda b: ["eng"])
    r = ioc.post("/api/ocr", json={"path": str(img)})
    assert r.json()["error_code"] == "ERR_OCR_LANG_MISSING"


def test_migration_drops_old_ollama_keys(tmp_path):
    import sqlite3

    from app.core.migrations import DEFAULT_MIGRATIONS_DIR, run_migrations

    data = tmp_path / "d"
    data.mkdir()
    db = data / "mizaj.db"
    # a database that stopped at 004 and still carries the old keys
    mig = tmp_path / "mig"
    mig.mkdir()
    for f in sorted(DEFAULT_MIGRATIONS_DIR.glob("00[1-4]_*.sql")):
        (mig / f.name).write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
    run_migrations(db, data / "backups", mig)
    conn = sqlite3.connect(db)
    for k, v in (("online_ollama", "true"), ("ollama_model", "x"), ("theme", "light")):
        conn.execute("INSERT INTO settings(key, value, updated_at) VALUES (?,?,'t')", (k, v))
    conn.commit()
    conn.close()
    run_migrations(db, data / "backups")  # real migrations incl. 005
    conn = sqlite3.connect(db)
    keys = {r[0] for r in conn.execute("SELECT key FROM settings")}
    conn.close()
    assert "online_ollama" not in keys and "ollama_model" not in keys
    assert "theme" in keys
    run_migrations(db, data / "backups")  # idempotent
