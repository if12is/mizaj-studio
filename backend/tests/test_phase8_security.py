# ruff: noqa: E501, F811
"""Phase 8 / Slice 8.1: backend security regression tests.

Every test either FAILED before the matching fix (see backend/SECURITY_REVIEW.md) or locks a
property that was verified safe during the audit (marked "lock").
"""

from __future__ import annotations

import ast
import asyncio
import hashlib
import json
import logging
import os
import socket
import sqlite3
import subprocess
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from io_helpers import ioc, set_setting  # noqa: F401

from app.core import security
from app.core.errors import MizajError
from app.main import create_app
from app.resources import net

TOKEN = "k" * 43
FIX = Path(__file__).parent / "fixtures"
APP = Path(__file__).resolve().parent.parent / "app"


@pytest.fixture
def secure(data_dir):
    app = create_app(data_dir, api_token=TOKEN)
    with TestClient(app, base_url="http://127.0.0.1:8765") as c:
        c.data_dir = data_dir
        yield c


def hdr(**extra):
    return {"X-Mizaj-Token": TOKEN, **extra}


def code_of(r):
    return r.json().get("error_code")


# =============================================================== 8.1.1 token
def test_token_required_for_every_route_except_health(secure):
    for method, path in [
        ("get", "/api/settings"),
        ("get", "/api/projects"),
        ("post", "/api/tashkeel"),
        ("post", "/api/tashkeel/stream"),
        ("get", "/api/batch/nope/events"),
        ("get", "/api/nonexistent"),
        ("delete", "/api/legal/law-index"),
    ]:
        r = getattr(secure, method)(path)
        assert r.status_code == 401, (path, r.status_code)
        assert code_of(r) == "ERR_UNAUTHORIZED"
        assert set(r.json()) == {"error_code", "message_ar", "message_en", "details"}


def test_token_wrong_or_empty_rejected_and_correct_accepted(secure):
    assert secure.get("/api/settings", headers={"X-Mizaj-Token": "wrong"}).status_code == 401
    assert secure.get("/api/settings", headers={"X-Mizaj-Token": ""}).status_code == 401
    assert secure.get("/api/settings", headers={"X-Mizaj-Token": TOKEN + "x"}).status_code == 401
    assert secure.get("/api/settings", headers={"X-Mizaj-Token": TOKEN[:-1]}).status_code == 401
    assert secure.get("/api/settings", headers=hdr()).status_code == 200
    r = secure.post("/api/tashkeel", json={"text": "كتاب"}, headers=hdr())
    assert r.status_code == 200


def test_token_compare_is_constant_time_primitive():
    import inspect

    src = inspect.getsource(security.SecurityMiddleware)
    assert "hmac.compare_digest" in src


def test_health_public_is_minimal_and_authorized_is_full(secure):
    pub = secure.get("/health")
    assert pub.status_code == 200 and set(pub.json()) == {"status", "version"}
    bad = secure.get("/health", headers={"X-Mizaj-Token": "nope"})
    assert bad.status_code == 200 and set(bad.json()) == {"status", "version"}
    full = secure.get("/health", headers=hdr()).json()
    assert {"engine_mode", "db_user_version", "models_dir", "engines"} <= set(full)
    assert secure.post("/health").status_code == 401  # only GET is public


def test_sse_stream_requires_token(secure):
    body = {"text": "كتاب جميل"}
    assert secure.post("/api/tashkeel/stream", json=body).status_code == 401
    with secure.stream("POST", "/api/tashkeel/stream", json=body, headers=hdr()) as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers["content-type"]


def test_auth_disabled_without_token_warns_once(data_dir, caplog, monkeypatch):
    monkeypatch.delenv("MIZAJ_API_TOKEN", raising=False)
    monkeypatch.setattr(security, "_warned_no_token", False)
    with caplog.at_level(logging.WARNING, logger="mizaj.security"):
        create_app(data_dir / "a")
        app = create_app(data_dir / "b")
    warns = [r for r in caplog.records if "authentication is DISABLED" in r.getMessage()]
    assert len(warns) == 1
    with TestClient(app) as c:
        assert c.get("/api/settings").status_code == 200


def test_env_token_is_read_and_scrubbed_from_environment(data_dir, monkeypatch):
    monkeypatch.setenv("MIZAJ_API_TOKEN", TOKEN)
    app = create_app(data_dir)
    assert app.state.api_token == TOKEN
    assert "MIZAJ_API_TOKEN" not in os.environ  # not inherited by tesseract & co
    with TestClient(app, base_url="http://localhost") as c:
        assert c.get("/api/settings").status_code == 401
        assert c.get("/api/settings", headers=hdr()).status_code == 200


def test_cli_flag_is_fallback(monkeypatch, data_dir):
    import app.main as m

    seen = {}

    def fake(d, api_token=None):
        seen["t"] = api_token
        raise RuntimeError("stop before serving")

    monkeypatch.delenv("MIZAJ_API_TOKEN", raising=False)
    monkeypatch.setattr(m, "create_app", fake)
    with pytest.raises(RuntimeError):
        m.main(["--data-dir", str(data_dir), "--api-token", "abc"])
    assert seen["t"] == "abc"


def test_token_never_logged(secure, caplog):
    with caplog.at_level(logging.DEBUG):
        secure.get("/api/settings", headers=hdr())
        secure.get("/api/settings", headers={"X-Mizaj-Token": "guess-123"})
        secure.post("/api/tashkeel", json={"text": 5}, headers=hdr())
    assert TOKEN not in caplog.text and "guess-123" not in caplog.text


def test_cors_preflight_allows_token_header_without_token(secure):
    r = secure.options(
        "/api/tashkeel",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-mizaj-token",
        },
    )
    assert r.status_code == 200
    assert "x-mizaj-token" in r.headers["access-control-allow-headers"].lower()
    assert r.headers["access-control-allow-origin"] in ("null", "*")
    evil = secure.options(
        "/api/tashkeel",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert "access-control-allow-origin" not in evil.headers


def test_cross_origin_simple_requests_cannot_mutate_lock(data_dir, monkeypatch):
    """Dev mode (no token): a web page can send a 'simple' POST without preflight; the API only
    accepts application/json so the body is never processed."""
    monkeypatch.delenv("MIZAJ_API_TOKEN", raising=False)
    with TestClient(create_app(data_dir)) as c:
        for ct in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data"):
            r = c.post("/api/projects", content='{"name":"x"}', headers={"Content-Type": ct, "Origin": "https://evil.example"})
            assert r.status_code == 422, ct
        assert c.get("/api/projects").json() == []


def test_openapi_and_docs_are_not_served(secure):
    for p in ("/openapi.json", "/docs", "/redoc"):
        assert secure.get(p, headers=hdr()).status_code == 404


# =============================================================== 8.1.2 Host header
@pytest.mark.parametrize(
    "host",
    ["evil.example", "evil.example:8765", "127.0.0.1.evil.example", "localhost.evil.example",
     "127.0.0.1@evil.example", "10.0.0.5:80", "testserver", "", "0.0.0.0:80"],
)  # fmt: skip
def test_bad_host_rejected_even_with_valid_token(secure, host):
    r = secure.get("/api/settings", headers=hdr(Host=host))
    assert r.status_code == 421 and code_of(r) == "ERR_HOST_NOT_ALLOWED"
    assert secure.get("/health", headers={"Host": host}).status_code == 421


@pytest.mark.parametrize("host", ["127.0.0.1", "127.0.0.1:55321", "localhost", "LOCALHOST:80"])
def test_loopback_hosts_accepted(secure, host):
    assert secure.get("/api/settings", headers=hdr(Host=host)).status_code == 200


def test_host_check_applies_without_token_too(data_dir, monkeypatch):
    monkeypatch.delenv("MIZAJ_API_TOKEN", raising=False)
    with TestClient(create_app(data_dir)) as c:
        assert c.get("/api/settings", headers={"Host": "rebind.example"}).status_code == 421


# =============================================================== body size (DoS)
def test_body_limit_content_length_and_chunked(secure, monkeypatch):
    monkeypatch.setattr(security, "MAX_BODY_BYTES", 2000)
    big = json.dumps({"text": "ك" * 5000})
    r = secure.post("/api/tashkeel", content=big, headers=hdr(**{"Content-Type": "application/json"}))
    assert r.status_code == 413 and code_of(r) == "ERR_PAYLOAD_TOO_LARGE"

    def gen():
        for i in range(0, len(big), 500):
            yield big[i : i + 500].encode()

    r = secure.post("/api/tashkeel", content=gen(), headers=hdr(**{"Content-Type": "application/json"}))
    assert r.status_code == 413


@pytest.mark.parametrize(
    "path,body",
    [
        ("/api/spelling/suggest", {"word": "ك" * 5000}),
        ("/api/legal/templates/preview", {"body": "x" * 2_100_000}),
        ("/api/tools/languagetool/check", {"text": "x" * 300_000}),
        ("/api/dictionary/import", {"entries": [{"word_or_phrase": "a" * 600, "diacritized_form": "b"}]}),
        ("/api/io/export", {"target_path": "/tmp/x.txt", "text": "x" * 5_000_001}),
    ],
)  # fmt: skip
def test_field_length_limits(client, path, body):
    r = client.post(path, json=body)
    assert r.status_code == 422 and code_of(r) == "ERR_VALIDATION", (path, r.status_code)


# =============================================================== 8.1.3 paths
BAD_PATHS = [
    "//server/share/a.docx",
    "/tmp/../etc/a.docx",
    "/tmp/CON.docx",
    "/tmp/nul",
    "/tmp/COM1.docx",
    "/tmp/AUX.txt.docx",
    "/tmp/a.docx:stream",
    "/tmp/x\x00.docx",
    "\\\\server\\share\\a.docx",
    "\\\\.\\pipe\\mizaj",
    "\\\\?\\C:\\a.docx",
    "relative/a.docx",
    "",
]


@pytest.mark.parametrize("bad", BAD_PATHS)
def test_safe_path_rejects(bad):
    with pytest.raises(MizajError) as e:
        security.safe_path(bad, "path")
    assert e.value.status == 422 and e.value.error_code == "ERR_VALIDATION"


ENDPOINTS_IN = [
    ("/api/docx/import", lambda p: {"path": p, "project_id": 1}),
    ("/api/docx/export", lambda p: {"source_path": p, "target_path": "/tmp/o.docx"}),
    ("/api/io/import", lambda p: {"path": p}),
    ("/api/io/convert", lambda p: {"input_path": p, "output_path": "/tmp/o.docx"}),
    ("/api/ocr", lambda p: {"path": p}),
    ("/api/packs/apply", lambda p: {"path": p}),
    ("/api/packs/v2/preview", lambda p: {"path": p}),
    ("/api/backup/inspect", lambda p: {"path": p}),
    ("/api/backup/restore", lambda p: {"path": p}),
    ("/api/quran/install", lambda p: {"kind": "uthmani", "source_path": p}),
    ("/api/resources/ayaspell-ar/import", lambda p: {"path": p, "accept_license": True}),
]
ENDPOINTS_OUT = [
    ("/api/docx/export", lambda p: {"source_path": str(FIX / "sample_ar.docx"), "target_path": p}),
    ("/api/io/convert", lambda p: {"input_path": str(FIX / "sample_ar.docx"), "output_path": p}),
    ("/api/io/export", lambda p: {"target_path": p, "text": "x"}),
    ("/api/packs/v2/export", lambda p: {"target_path": p, "name": "n", "license": "CC0"}),
    ("/api/backup/export", lambda p: {"target_path": p}),
]


@pytest.mark.parametrize("bad", ["//server/share/a.docx", "/tmp/CON.docx", "/tmp/../a.docx",
                                 "\\\\server\\share\\a.docx", "\\\\.\\pipe\\x", "\\\\?\\C:\\a"])  # fmt: skip
@pytest.mark.parametrize("path,mk", ENDPOINTS_IN, ids=[e[0] for e in ENDPOINTS_IN])
def test_every_input_endpoint_rejects_unc_device_and_dotdot(client, path, mk, bad):
    r = client.post(path, json=mk(bad))
    assert r.status_code == 422 and code_of(r) == "ERR_VALIDATION", (path, bad, r.status_code)


@pytest.mark.parametrize("bad", ["//server/share/o.docx", "/tmp/CON.docx", "\\\\.\\pipe\\x"])
@pytest.mark.parametrize("path,mk", ENDPOINTS_OUT, ids=[e[0] for e in ENDPOINTS_OUT])
def test_every_output_endpoint_rejects_unc_and_device(client, path, mk, bad):
    r = client.post(path, json=mk(bad))
    assert r.status_code == 422 and code_of(r) == "ERR_VALIDATION", (path, bad, r.status_code)


def test_batch_dirs_rejected(client, tmp_path):
    ok = tmp_path / "in"
    ok.mkdir()
    for i, o in [("//server/share", str(tmp_path / "o")), (str(ok), "\\\\server\\share"),
                 (str(ok), "/tmp/../x"), (str(ok), str(client.data_dir)),
                 (str(ok), str(client.data_dir / "sub"))]:  # fmt: skip
        r = client.post("/api/batch", json={"input_dir": i, "output_dir": o})
        assert r.status_code == 422, (i, o, r.status_code)


@pytest.mark.parametrize("path,mk", ENDPOINTS_OUT, ids=[e[0] for e in ENDPOINTS_OUT])
def test_exports_never_write_into_data_dir(client, path, mk):
    suffix = {"/api/packs/v2/export": ".mizajpack", "/api/backup/export": ".mizajbackup",
              "/api/io/export": ".txt"}.get(path, ".docx")  # fmt: skip
    target = client.data_dir / f"evil{suffix}"
    r = client.post(path, json=mk(str(target)))
    assert r.status_code == 422, (path, r.status_code, r.text[:200])
    assert not target.exists()
    sub = client.data_dir / "logs" / f"x{suffix}"
    assert client.post(path, json=mk(str(sub))).status_code == 422


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_output_symlink_not_followed(client, tmp_path):
    victim = tmp_path / "victim.txt"
    victim.write_text("precious")
    link = tmp_path / "out.txt"
    try:
        os.symlink(victim, link)
    except OSError:
        pytest.skip("cannot create symlink")
    r = client.post("/api/io/export", json={"target_path": str(link), "text": "pwned"})
    assert r.status_code == 422
    assert victim.read_text() == "precious"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="needs symlinks")
def test_output_through_symlinked_dir_into_data_dir_rejected(client, tmp_path):
    link = tmp_path / "linkdir"
    try:
        os.symlink(client.data_dir, link, target_is_directory=True)
    except OSError:
        pytest.skip("cannot create symlink")
    r = client.post("/api/io/export", json={"target_path": str(link / "x.txt"), "text": "x"})
    assert r.status_code == 422
    assert not (client.data_dir / "x.txt").exists()


def test_output_extension_allowlist(client, tmp_path):
    src = tmp_path / "a.txt"
    src.write_text("كتاب", encoding="utf-8")
    for ext in (".exe", ".bat", ".lnk", ".dll", ""):
        r = client.post("/api/io/convert", json={"input_path": str(src), "output_path": str(tmp_path / f"o{ext}")})
        assert r.status_code == 422, ext
        r = client.post("/api/io/export", json={"target_path": str(tmp_path / f"e{ext}"), "text": "x"})
        assert r.status_code == 422, ext
    assert not list(tmp_path.glob("o*")) and not list(tmp_path.glob("e*"))


def test_input_extension_allowlist(client, tmp_path):
    f = tmp_path / "payload.exe"
    f.write_bytes(b"MZ")
    assert client.post("/api/io/import", json={"path": str(f)}).status_code == 422
    assert client.post("/api/ocr", json={"path": str(f)}).status_code == 422
    assert client.post("/api/packs/apply", json={"path": str(f)}).status_code == 422


def test_source_never_overwritten(client, tmp_path):
    src = tmp_path / "a.txt"
    src.write_text("كتاب", encoding="utf-8")
    r = client.post("/api/io/convert", json={"input_path": str(src), "output_path": str(src)})
    assert r.status_code == 422 and src.read_text(encoding="utf-8") == "كتاب"
    alias = tmp_path / "sub" / ".." / "a.txt"
    (tmp_path / "sub").mkdir()
    r = client.post("/api/io/convert", json={"input_path": str(src), "output_path": str(alias)})
    assert r.status_code == 422


@pytest.mark.skipif(not hasattr(os, "mkfifo"), reason="needs mkfifo")
def test_special_files_are_not_opened(client, tmp_path):
    fifo = tmp_path / "pipe.txt"
    os.mkfifo(fifo)
    r = client.post("/api/io/import", json={"path": str(fifo)})
    assert r.status_code == 422  # would block forever on open()
    assert client.post("/api/io/import", json={"path": "/dev/zero"}).status_code == 422


def test_input_size_limit(client, tmp_path, monkeypatch):
    from app.api import io as io_api

    monkeypatch.setattr(io_api, "MAX_IN", 1000)
    f = tmp_path / "big.txt"
    f.write_bytes(b"a" * 5000)
    r = client.post("/api/io/import", json={"path": str(f)})
    assert r.status_code == 413 and code_of(r) == "ERR_FILE_TOO_LARGE"


def test_missing_input_is_404(client, tmp_path):
    r = client.post("/api/io/import", json={"path": str(tmp_path / "nope.txt")})
    assert r.status_code == 404


def test_stored_source_path_is_revalidated(client, tmp_path):
    """A restored backup can plant an arbitrary source_docx_path (UNC => NTLM leak on Windows)."""
    pid = client.post("/api/projects", json={"name": "p"}).json()["id"]
    did = client.post("/api/documents", json={"project_id": pid, "title": "t", "raw_content": "كتاب"}).json()["id"]
    con = sqlite3.connect(client.data_dir / "mizaj.db")
    con.execute("UPDATE documents SET source_docx_path=? WHERE id=?", ("//server/share/x.docx", did))
    con.commit()
    con.close()
    out = tmp_path / "o.docx"
    r = client.post("/api/docx/export", json={"document_id": did, "target_path": str(out)})
    assert r.status_code == 200 and out.exists()  # generated from text, never opened the UNC path


def test_batch_output_escape_via_symlink_is_skipped(client, tmp_path):
    if not hasattr(os, "symlink"):
        pytest.skip("no symlink")
    i, o, outside = tmp_path / "in", tmp_path / "out", tmp_path / "outside"
    for d in (i, o, outside, i / "sub"):
        d.mkdir(parents=True, exist_ok=True)
    (i / "sub" / "a.txt").write_text("كتاب", encoding="utf-8")
    try:
        os.symlink(outside, o / "sub", target_is_directory=True)
    except OSError:
        pytest.skip("cannot create symlink")
    jid = client.post("/api/batch", json={"input_dir": str(i), "output_dir": str(o), "formats": ["txt"]}).json()["job_id"]
    for _ in range(100):
        st = client.get(f"/api/batch/{jid}").json()
        if st["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(0.1)
    assert not list(outside.iterdir())
    assert st["succeeded"] == 0 and st["errors"]


# =============================================================== 8.1.4 XML / ZIP
def _docx_with(tmp_path, extra: dict[str, bytes] | None = None, replace: dict[str, bytes] | None = None):
    src = FIX / "sample_ar.docx"
    out = tmp_path / "evil.docx"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = (replace or {}).get(info.filename)
            zout.writestr(info.filename, zin.read(info) if data is None else data)
        for n, b in (extra or {}).items():
            zout.writestr(n, b)
    return out


def _xxe_body(tmp_path):
    secret = tmp_path / "secret.txt"
    secret.write_text("TOPSECRET-LOCAL-FILE")
    with zipfile.ZipFile(FIX / "sample_ar.docx") as z:
        doc = z.read("word/document.xml").decode("utf-8")
    dtd = f'<!DOCTYPE d [<!ENTITY xxe SYSTEM "{Path(secret).as_uri()}">]>'
    head, rest = doc.split("?>", 1)
    doc = head + "?>" + dtd + rest
    doc = doc.replace("<w:t>", "<w:t>&xxe;", 1) if "<w:t>" in doc else doc.replace("<w:t ", "<w:t>&xxe;</w:t><w:t ", 1)
    return doc.encode("utf-8")


def test_docx_with_dtd_or_entities_is_rejected(client, tmp_path):
    evil = _docx_with(tmp_path, replace={"word/document.xml": _xxe_body(tmp_path)})
    r = client.post("/api/io/import", json={"path": str(evil)})
    assert r.status_code == 422 and code_of(r) == "ERR_DOCX_CORRUPT", r.text
    assert "TOPSECRET" not in r.text
    pid = client.post("/api/projects", json={"name": "p"}).json()["id"]
    r = client.post("/api/docx/import", json={"path": str(evil), "project_id": pid})
    assert r.status_code == 422 and code_of(r) == "ERR_DOCX_CORRUPT"


def test_docx_billion_laughs_rejected_fast(client, tmp_path):
    laughs = (
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa">'
        + "".join(f'<!ENTITY e{i} "' + f"&e{i-1};" * 10 + '">' for i in range(1, 9) if True).replace("&e0;", "&a;")
        + "]><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body><w:p><w:r><w:t>&e8;</w:t></w:r></w:p></w:body></w:document>"
    )
    evil = _docx_with(tmp_path, replace={"word/document.xml": laughs.encode()})
    t = time.perf_counter()
    r = client.post("/api/io/import", json={"path": str(evil)})
    assert r.status_code == 422 and time.perf_counter() - t < 5


def test_python_docx_parser_does_not_expand_entities_lock():
    from docx.oxml import parse_xml

    import app.docx.service  # noqa: F401  (installs the hardened parser)

    secret = Path(__file__).parent / "fixtures" / "quran_mini.txt"
    xml = (
        f'<!DOCTYPE d [<!ENTITY x SYSTEM "{Path(secret).as_uri()}"><!ENTITY y "EXPANDED">]>'
        '<w:t xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">&x;&y;</w:t>'
    )
    el = parse_xml(xml)
    assert "EXPANDED" not in (el.text or "") and "بسم" not in (el.text or "")
    assert type(el).__name__ == "CT_Text"  # python-docx element classes survived the swap


def test_hardened_parser_flags():
    from lxml import etree

    p = security.hardened_xml_parser()
    xml = b'<!DOCTYPE d [<!ENTITY y "EXPANDED">]><d>&y;</d>'
    assert "EXPANDED" not in (etree.fromstring(xml, p).text or "")
    with pytest.raises(etree.XMLSyntaxError):  # very deep nesting stays refused (no huge_tree)
        etree.fromstring(b"<a>" * 5000 + b"</a>" * 5000, p)


def test_docx_zip_bomb_ratio_rejected(client, tmp_path):
    evil = _docx_with(tmp_path, extra={"word/media/bomb.bin": bytes(60 * 1024 * 1024)})
    assert evil.stat().st_size < 200_000
    r = client.post("/api/io/import", json={"path": str(evil)})
    assert r.status_code == 422 and code_of(r) == "ERR_DOCX_CORRUPT"
    assert "rejected" in r.json()["details"]["reason"]


def test_docx_member_count_bomb_rejected(client, tmp_path):
    evil = _docx_with(tmp_path, extra={f"word/media/f{i}.bin": b"x" for i in range(10_500)})
    r = client.post("/api/io/import", json={"path": str(evil)})
    assert r.status_code == 422 and code_of(r) == "ERR_DOCX_CORRUPT"


def test_docx_still_opens_normally(client):
    r = client.post("/api/io/import", json={"path": str(FIX / "sample_ar.docx")})
    assert r.status_code == 200 and r.json()["text"]


def _epub(path, xhtml: bytes, extra=None):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("OEBPS/c1.xhtml", xhtml)
        for n, b in (extra or {}).items():
            z.writestr(n, b)
    return path


XH = '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>{}</p></body></html>'


def test_epub_entity_declarations_skipped(client, tmp_path):
    ok = _epub(tmp_path / "ok.epub", XH.format("كتاب جميل").encode())
    assert "كتاب" in client.post("/api/io/import", json={"path": str(ok)}).json()["text"]
    evil = _epub(
        tmp_path / "evil.epub",
        ('<?xml version="1.0"?><!DOCTYPE html [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>' + XH.format("SECRETBODY &b;")).encode(),
    )
    r = client.post("/api/io/import", json={"path": str(evil)})
    assert r.status_code == 200 and "SECRETBODY" not in r.json()["text"]
    out = tmp_path / "out.epub"
    r = client.post("/api/io/convert", json={"input_path": str(evil), "output_path": str(out)})
    assert r.status_code == 200 and r.json()["stats"]["skipped"] == ["OEBPS/c1.xhtml"]


def test_epub_zip_bomb_rejected(client, tmp_path):
    evil = _epub(tmp_path / "bomb.epub", XH.format("x").encode(), {"OEBPS/b.bin": bytes(60 * 1024 * 1024)})
    r = client.post("/api/io/import", json={"path": str(evil)})
    assert r.status_code == 422 and code_of(r) == "ERR_FILE_INVALID"
    r = client.post("/api/io/convert", json={"input_path": str(evil), "output_path": str(tmp_path / "o.epub")})
    assert r.status_code == 422 and not (tmp_path / "o.epub").exists()
    assert not list(tmp_path.glob(".~mizaj_tmp*"))


def _v1_pack(path, members, extra=None):
    manifest = {
        "format": 1, "kind": "models", "version": "t",
        "files": [{"path": p, "sha256": hashlib.sha256(b).hexdigest(), "size": len(b)} for p, b in members.items()],
    }  # fmt: skip
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest))
        for p, b in members.items():
            z.writestr(p, b)
        for p, b in (extra or {}).items():
            z.writestr(p, b)
    return path


def test_pack_v1_member_count_and_ratio_bombs(client, tmp_path):
    members = {"catt_eo/a.onnx": b"x" * 100}
    many = _v1_pack(tmp_path / "many.mizajpack", members, {f"junk/{i}": b"" for i in range(6000)})
    r = client.post("/api/packs/apply", json={"path": str(many)})
    assert r.status_code == 422 and code_of(r) == "ERR_PACK_INVALID"
    bomb = _v1_pack(tmp_path / "bomb.mizajpack", members, {"junk/z.bin": bytes(80 * 1024 * 1024)})
    r = client.post("/api/packs/apply", json={"path": str(bomb)})
    assert r.status_code == 422 and code_of(r) == "ERR_PACK_INVALID"
    assert not (client.data_dir / "models" / "catt_eo").exists()


def test_pack_v2_ratio_bomb_rejected(client, tmp_path):
    p = tmp_path / "b.mizajpack"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps({"format": 2, "kind": "dictionary", "files": []}))
        z.writestr("dictionary.json", b" " * (70 * 1024 * 1024))
    r = client.post("/api/packs/v2/preview", json={"path": str(p)})
    assert r.status_code == 422 and code_of(r) == "ERR_PACK_INVALID"


def test_backup_zip_bomb_rejected(client, tmp_path):
    p = tmp_path / "b.mizajbackup"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", "{}")
        z.writestr("resources/junk.bin", bytes(80 * 1024 * 1024))
    r = client.post("/api/backup/inspect", json={"path": str(p)})
    assert r.status_code == 422 and code_of(r) == "ERR_BACKUP_INVALID"
    assert "ratio" in r.json()["details"]["reason"]


def test_pack_zip_slip_still_rejected_lock(client, tmp_path):
    members = {"../evil.onnx": b"x"}
    p = _v1_pack(tmp_path / "slip.mizajpack", {"catt_eo/a.onnx": b"x"})
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("manifest.json", json.dumps({"format": 1, "kind": "models", "version": "1", "files": [
            {"path": "../evil.onnx", "sha256": hashlib.sha256(b"x").hexdigest(), "size": 1}]}))
        z.writestr("../evil.onnx", b"x")
    del members
    r = client.post("/api/packs/apply", json={"path": str(p)})
    assert r.status_code == 422 and not (client.data_dir.parent / "evil.onnx").exists()


# =============================================================== 8.1.5 network & subprocess
@pytest.fixture
def no_proxy(monkeypatch):
    for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("NO_PROXY", "*")


@pytest.mark.parametrize(
    "addr",
    ["127.0.0.1", "10.0.0.5", "192.168.1.9", "172.16.0.3", "169.254.169.254", "100.64.0.1",
     "0.0.0.0", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "224.0.0.1"],
)  # fmt: skip
def test_resolve_public_blocks_non_global(monkeypatch, addr):
    fam = socket.AF_INET6 if ":" in addr else socket.AF_INET
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(fam, socket.SOCK_STREAM, 6, "", (addr, 443))])
    with pytest.raises(MizajError) as e:
        net.resolve_public("tanzil.net")
    assert e.value.error_code == "ERR_HOST_NOT_ALLOWED"


def test_resolve_public_blocks_if_any_answer_is_private(monkeypatch):
    infos = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, 443)) for a in ("93.184.216.34", "10.0.0.1")]
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: infos)
    with pytest.raises(MizajError):
        net.resolve_public("github.com")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: infos[:1])
    assert net.resolve_public("github.com") == "93.184.216.34"


def test_ip_literal_in_allowlist_is_still_blocked():
    net.allow_host("10.1.2.3")
    try:
        with pytest.raises(MizajError) as e:
            net._check_url("https://10.1.2.3/x")
        assert e.value.error_code == "ERR_HOST_NOT_ALLOWED"
    finally:
        net.ALLOWED_HOSTS.discard("10.1.2.3")


def test_download_to_allowlisted_host_resolving_privately_is_blocked(ioc, monkeypatch, tmp_path, no_proxy):
    """DNS rebinding / poisoned DNS: allowlisted name -> internal address must not be contacted."""
    set_setting(ioc, online_resources="true")
    connected = []
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.9", 443))])
    monkeypatch.setattr(socket, "create_connection", lambda *a, **k: connected.append(a) or (_ for _ in ()).throw(OSError("no")))
    with pytest.raises(MizajError) as e:
        net.download("https://tanzil.net/f", tmp_path / "f.bin", db_path=ioc.data_dir / "mizaj.db")
    assert e.value.error_code == "ERR_HOST_NOT_ALLOWED" and connected == []


class _Redir(BaseHTTPRequestHandler):
    target = "http://evil.example/x"
    big = 0

    def do_GET(self):  # noqa: N802
        if self.path == "/redir":
            self.send_response(302)
            self.send_header("Location", self.target)
            self.end_headers()
        elif self.path == "/big":
            self.send_response(200)
            self.send_header("Content-Length", str(self.big))
            self.end_headers()
            self.wfile.write(b"a" * self.big)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *a):  # noqa: D401
        pass


@pytest.fixture
def local_srv():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _Redir)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


@pytest.mark.parametrize("target", ["http://evil.example/x", "https://evil.example/x",
                                    "http://169.254.169.254/latest/meta-data", "https://10.0.0.1/x",
                                    "file:///etc/passwd", "ftp://tanzil.net/x"])  # fmt: skip
def test_redirects_are_rechecked(ioc, local_srv, tmp_path, target, no_proxy):
    set_setting(ioc, online_resources="true")
    _Redir.target = target
    with pytest.raises(MizajError) as e:
        net.download(local_srv + "/redir", tmp_path / "f.bin", db_path=ioc.data_dir / "mizaj.db")
    assert e.value.error_code in ("ERR_HOST_NOT_ALLOWED", "ERR_DOWNLOAD_FAILED")
    assert not (tmp_path / "f.bin").exists()


def test_download_size_limit_enforced(ioc, local_srv, tmp_path, no_proxy):
    set_setting(ioc, online_resources="true")
    _Redir.big = 5000
    with pytest.raises(MizajError) as e:
        net.download(local_srv + "/big", tmp_path / "f.bin", db_path=ioc.data_dir / "mizaj.db", max_bytes=1000)
    assert e.value.error_code == "ERR_DOWNLOAD_FAILED" and "limit" in e.value.message_en
    assert not (tmp_path / "f.bin").exists()


def test_tesseract_runs_without_shell_with_list_args_timeout_and_no_token(monkeypatch, tmp_path):
    from app.io import ocr

    seen = {}

    def fake_run(args, **kw):
        seen["args"], seen["kw"] = args, kw
        return subprocess.CompletedProcess(args, 0, b"level\tpage_num\n", b"")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setenv("MIZAJ_API_TOKEN", TOKEN)
    img = tmp_path / "a.png"
    img.write_bytes(b"x")
    ocr.ocr_image_file("/usr/bin/tesseract", img, "ara+eng")
    assert isinstance(seen["args"], list) and seen["args"][0] == "/usr/bin/tesseract"
    assert seen["args"][1] == str(img) and seen["args"][2:] == ["stdout", "-l", "ara+eng", "tsv"]
    assert seen["kw"].get("shell") is False and seen["kw"]["timeout"] > 0
    assert "MIZAJ_API_TOKEN" not in seen["kw"]["env"]
    assert seen["kw"]["stdin"] == subprocess.DEVNULL


@pytest.mark.parametrize("lang", ["-c", "ara -c x", "ara;rm", "../ara", "ara+", "+ara", "a", "--oem", "ara\nx"])
def test_ocr_language_cannot_inject_flags(lang):
    from app.io import ocr

    with pytest.raises(MizajError):
        ocr.tesseract_cmd("/bin/tesseract", Path("/tmp/a.png"), lang)


def test_ocr_endpoint_rejects_bad_lang(client, tmp_path):
    f = tmp_path / "a.png"
    f.write_bytes(b"x")
    assert client.post("/api/ocr", json={"path": str(f), "lang": "-psm"}).status_code == 422


def test_ocr_error_does_not_echo_stderr_or_paths(monkeypatch, tmp_path):
    from app.io import ocr

    monkeypatch.setattr(
        subprocess, "run",
        lambda a, **k: subprocess.CompletedProcess(a, 1, b"", b"Error opening /home/secret/user/file.png"),
    )  # fmt: skip
    with pytest.raises(MizajError) as e:
        ocr.ocr_image_file("/bin/t", tmp_path / "a.png", "ara")
    assert "secret" not in json.dumps(e.value.envelope())


# =============================================================== 8.1.6 injection & leakage
# merge.py: identifiers validated via PRAGMA table_info / constants; cache.py: only '?' placeholders;
# migrations.py: int() user_version.
VETTED_DYNAMIC_SQL = {"merge.py", "cache.py", "migrations.py"}


def test_no_dynamic_sql_outside_vetted_sites():
    """f-string / %-format / .format SQL is forbidden except packs2/merge.py (identifiers are
    validated against PRAGMA table_info and constants there)."""
    offenders = []
    for py in APP.rglob("*.py"):
        if "engine/catt" in py.as_posix():
            continue
        tree = ast.parse(py.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ("execute", "executemany", "executescript") and node.args:
                a = node.args[0]
                dyn = isinstance(a, ast.JoinedStr) or (isinstance(a, ast.BinOp) and isinstance(a.op, ast.Mod)) or (isinstance(a, ast.Call) and isinstance(a.func, ast.Attribute) and a.func.attr == "format")
                if dyn and py.name not in VETTED_DYNAMIC_SQL:
                    offenders.append(f"{py.relative_to(APP)}:{node.lineno}")
    assert not offenders, offenders


def test_undo_with_tampered_journal_cannot_inject_sql(client):
    con = sqlite3.connect(client.data_dir / "mizaj.db")
    evil = [
        {"t": "settings", "pk": "key", "op": "delete", "id": "x", "after": "z",
         "chk": "updated_at FROM settings; DROP TABLE legal_templates; --"},
        {"t": "settings", "pk": "key", "op": "restore", "id": "k", "after": "z",
         "row": {"key) VALUES ('a','b'); DROP TABLE settings; --": 1}},
    ]  # fmt: skip
    con.execute("INSERT INTO pack_imports(id, kind, journal_json) VALUES ('evil','dictionary',?)", (json.dumps(evil),))
    con.commit()
    con.close()
    r = client.post("/api/packs/v2/undo/evil")
    assert r.status_code == 200 and r.json()["reverted"] == 0
    con = sqlite3.connect(client.data_dir / "mizaj.db")
    names = {x[0] for x in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    con.close()
    assert {"settings", "legal_templates"} <= names


def test_connection_ignores_untrusted_schema(data_dir):
    from app.core.database import connect

    c = connect(data_dir / "x.db")
    assert c.execute("PRAGMA trusted_schema").fetchone()[0] == 0
    c.close()


def test_template_engine_is_not_evaluating_code(client, tmp_path):
    sentinel = tmp_path / "pwned"
    body = f"{{{{ __import__('pathlib').Path('{sentinel}').touch() }}}} {{{{ name.__class__ }}}} {{{{ 7*7 }}}}"
    r = client.post("/api/legal/templates/preview", json={"body": body, "vars": [{"name": "name", "type": "text"}], "values": {"name": "x"}})
    assert r.status_code in (200, 422)
    assert not sentinel.exists() and "49" not in r.text and "<class" not in r.text


def test_template_deep_nesting_does_not_crash_server(client):
    body = "{{#if a}}" * 20000 + "x" + "{{/if}}" * 20000
    r = client.post("/api/legal/templates/preview", json={"body": body, "vars": [{"name": "a", "type": "text"}]})
    assert r.status_code in (200, 422, 500) and "error_code" in r.text or r.status_code == 200
    assert client.get("/health").status_code == 200


def test_document_text_not_logged(client, caplog):
    marker = "سرّي_جدا_MARKER_9731"
    with caplog.at_level(logging.DEBUG):
        client.post("/api/tashkeel", json={"text": f"هذا نص {marker}"})
        client.post("/api/tashkeel", json={"text": f"هذا {marker}", "mode": "bogus"})
        client.post("/api/spelling/check", json={"text": marker})
        client.post("/api/legal/lint", json={"text": marker})
        client.post("/api/io/export", json={"target_path": "relative.txt", "text": marker})
    assert marker not in caplog.text
    for rec in caplog.records:
        assert marker not in rec.getMessage()


def test_validation_errors_do_not_echo_input(client):
    r = client.post("/api/tashkeel", json={"text": "كتاب", "mode": "SECRET-INPUT-VALUE"})
    assert r.status_code == 422 and "SECRET-INPUT-VALUE" not in r.text


def test_unhandled_errors_have_no_traceback_or_internal_message(data_dir, monkeypatch):
    from app.api import settings as settings_api

    def boom():
        raise RuntimeError("boom /home/secret/path.py line 12")

    app = create_app(data_dir)
    app.add_api_route("/api/_boom", boom)
    with TestClient(app, raise_server_exceptions=False) as c:
        r = c.get("/api/_boom")
    del settings_api
    assert r.status_code == 500 and code_of(r) == "ERR_INTERNAL"
    assert "boom" not in r.text and "Traceback" not in r.text and "secret" not in r.text


def test_batch_and_download_errors_do_not_leak_exception_text(client, tmp_path, monkeypatch):
    from app.io import batch

    i, o = tmp_path / "in", tmp_path / "out"
    i.mkdir()
    (i / "a.txt").write_text("كتاب", encoding="utf-8")

    def boom(*a, **k):
        raise RuntimeError("/home/secret/leak")

    monkeypatch.setattr(batch, "convert_file", boom)
    jid = client.post("/api/batch", json={"input_dir": str(i), "output_dir": str(o), "formats": ["txt"]}).json()["job_id"]
    for _ in range(100):
        st = client.get(f"/api/batch/{jid}").json()
        if st["status"] != "running" and st["status"] != "queued":
            break
        time.sleep(0.1)
    assert st["errors"] and "secret" not in json.dumps(st)


# =============================================================== DoS: regex backtracking
def _timed(fn, limit):
    t = time.perf_counter()
    out = fn()
    dt = time.perf_counter() - t
    assert dt < limit, f"took {dt:.1f}s (limit {limit}s)"
    return out


def test_redos_email_mask_is_linear():
    from app.spelling.text import mask_spans

    _timed(lambda: mask_spans("a" * 60_000 + "@" + "b" * 30_000), 2)  # was O(n^2): ~25 s
    _timed(lambda: mask_spans("ك" * 60_000), 2)


def test_redos_typography_runs_are_linear():
    from app.spelling.text import Masker
    from app.spelling.typography import TypographyOptions, check_typography

    for text in ("ك" * 40_000, "ك" + "\u064e" * 40_000, "ﻻ" + "ك" * 40_000):
        _timed(lambda t=text: check_typography(t, Masker(t), TypographyOptions()), 3)
    # behaviour kept: a run containing a Persian letter is still reported as one edit
    t = "هذا كتاب" + "ی"
    hits = check_typography(t, Masker(t), TypographyOptions())
    assert any(h["code"] == "TYPO_PERSIAN_LETTER" for h in hits)


def test_redos_paragraph_split_is_linear(client):
    text = "كلمة\n" * 40_000  # no blank lines: the old lazy regex was O(n^2)
    r = _timed(lambda: client.post("/api/spelling/readability", json={"text": text}), 4)
    assert r.status_code == 200
    two = client.post("/api/spelling/readability", json={"text": "أول فقرة\n\n\nثاني فقرة\n \nثالثة"})
    assert two.json()["metrics"]["paragraphs"] == 3


def test_redos_money_lint_is_linear(client):
    r = _timed(lambda: client.post("/api/legal/lint", json={"text": "1." * 15_000}), 4)
    assert r.status_code == 200
    ok = client.post("/api/legal/lint", json={"text": "المبلغ 1500 ريال سعودي"})
    assert ok.status_code == 200


def test_spelling_unbroken_giant_word_is_bounded(client):
    """One 4k-char 'word' used to take ~13 s (and ~GBs of RAM at 30k chars) in the suggester."""
    r = _timed(lambda: client.post("/api/spelling/check", json={"text": "مكرر" * 1000}), 3)
    assert r.status_code == 200 and r.json()["stats"]["elapsed_ms"] < 3000


PATHOLOGICAL = {
    "spaces": " " * 30_000 + "x",
    "dots": "." * 30_000,
    "dotted": "1." * 15_000,
    "slashes": "1/" * 15_000,
    "at": "a" * 30_000 + "@" + "b" * 10_000,
    "arabic": "ك" * 30_000,
    "marks": "ك" + "\u064e" * 30_000,
    "parens": "(" * 15_000 + ")" * 15_000,
    "article": "المادة (" * 5_000,
    "bis": "مكرر" * 5_000,
    "newlines": "\n" * 30_000,
    "quotes": '"' * 30_000,
}
TEXT_ENDPOINTS = ["/api/spelling/check", "/api/spelling/readability", "/api/spelling/normalize",
                  "/api/legal/lint", "/api/legal/citations", "/api/legal/redact",
                  "/api/legal/defined-terms", "/api/legal/clauses", "/api/legal/check-amounts",
                  "/api/quran/detect", "/api/arud/analyze", "/api/text/dialect-hint"]  # fmt: skip


@pytest.mark.parametrize("name", list(PATHOLOGICAL))
def test_pathological_inputs_finish_quickly(client, name):
    text = PATHOLOGICAL[name]
    for ep in TEXT_ENDPOINTS:
        t = time.perf_counter()
        r = client.post(ep, json={"text": text})
        dt = time.perf_counter() - t
        assert r.status_code in (200, 422), (ep, name, r.status_code)
        assert dt < 10, f"{ep} on {name} took {dt:.1f}s"


# =============================================================== misc
def test_security_middleware_streams_sse_unbuffered(secure):
    """The ASGI middleware must not buffer: the first SSE event arrives before the body ends."""

    async def scenario():
        import httpx

        tr = httpx.ASGITransport(app=secure.app)
        async with httpx.AsyncClient(transport=tr, base_url="http://127.0.0.1") as c:
            async with c.stream("POST", "/api/tashkeel/stream", json={"text": "كتاب. " * 50}, headers=hdr()) as r:
                assert r.status_code == 200
                async for line in r.aiter_lines():
                    if line.startswith("data:") or line.startswith("event:"):
                        return True
        return False

    assert asyncio.run(scenario())


def test_error_envelope_for_unauthorized_has_cors_headers(secure):
    r = secure.get("/api/settings", headers={"Origin": "null"})
    assert r.status_code == 401 and r.headers.get("access-control-allow-origin") == "null"
