"""Resource states: install, auto-enable, already-installed guard, update, uninstall, detection."""

from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile
from pathlib import Path

import pytest
from io_helpers import build_client, set_setting

from app.core.errors import MizajError
from app.resources import downloads, manager
from app.tools import discovery


def make_zip(files: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return buf.getvalue()


ZIP = make_zip(
    {"tess/tesseract.exe": b"MZ", "tess/tesseract": b"#!", "tess/tessdata/ara.traineddata": b"x"}
)
FLAT = b"hello dictionary"


def entry(rid="r1", blob=FLAT, **kw):
    e = {
        "id": rid, "name": rid, "kind": "spell-dictionary", "url": "https://github.com/x/f",
        "filename": "f.bin", "sha256": hashlib.sha256(blob).hexdigest(), "size": len(blob),
        "license": "CC0", "license_url": "http://x", "attribution": "a",
    }  # fmt: skip
    e.update(kw)
    return e


@pytest.fixture
def env(data_dir, monkeypatch):
    """App with the online switch on and a downloader that writes `blobs[url]` (no network)."""
    blobs: dict[str, bytes] = {}
    calls: list[str] = []

    def fake_fetch(url, dest, **kw):
        calls.append(url)
        blob = blobs[url]
        Path(dest).parent.mkdir(parents=True, exist_ok=True)
        Path(dest).write_bytes(blob)
        return hashlib.sha256(blob).hexdigest()

    monkeypatch.setattr(downloads, "fetch", fake_fetch)
    with build_client(data_dir) as c:
        c.data_dir = data_dir
        c.blobs, c.calls = blobs, calls
        set_setting(c, online_resources="true")
        yield c
    manager.set_catalog(None)


def wait_job(c, jid):
    for _ in range(200):
        st = c.get(f"/api/resources/jobs/{jid}").json()
        if st["status"] not in ("queued", "running"):
            return st
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def item(c, rid):
    return next(r for r in c.get("/api/resources").json()["resources"] if r["id"] == rid)


def install(c, rid="r1"):
    r = c.post(f"/api/resources/{rid}/download", json={"accept_license": True})
    assert r.status_code == 202, r.text
    return wait_job(c, r.json()["job_id"])


def test_download_installs_and_auto_enables_with_sizes(env):
    manager.set_catalog([entry()])
    env.blobs["https://github.com/x/f"] = FLAT
    assert item(env, "r1")["installed"] is None
    assert item(env, "r1")["download_size"] == len(FLAT)
    assert item(env, "r1")["installed_size"] is None
    job = install(env)
    assert job["status"] == "done"
    it = item(env, "r1")
    assert it["installed"] and it["enabled"] is True
    assert it["installed_size"] >= len(FLAT)
    assert it["update_available"] is False


def test_network_resource_is_not_auto_enabled_and_can_be_enabled(env):
    manager.set_catalog([entry(network=True)])
    env.blobs["https://github.com/x/f"] = FLAT
    install(env)
    it = item(env, "r1")
    assert it["installed"] and it["enabled"] is False
    assert env.post("/api/resources/r1/enabled", json={"enabled": True}).json()["enabled"] is True
    assert item(env, "r1")["enabled"] is True
    env.post("/api/resources/r1/enabled", json={"enabled": False})
    assert item(env, "r1")["enabled"] is False


def test_enable_requires_install(env):
    manager.set_catalog([entry()])
    r = env.post("/api/resources/r1/enabled", json={"enabled": True})
    assert r.status_code == 409 and r.json()["error_code"] == "ERR_RESOURCE_NOT_INSTALLED"


def test_job_reports_installing_phase_for_archives(env, monkeypatch):
    manager.set_catalog([entry(blob=ZIP, extract_to="tess")])
    env.blobs["https://github.com/x/f"] = ZIP
    seen = []
    orig = manager._post_install

    def spy(data_dir, r):
        seen.append(manager._find_job(data_dir, r["id"]).fields["phase"])
        orig(data_dir, r)

    monkeypatch.setattr(manager, "_post_install", spy)
    assert install(env)["status"] == "done"
    assert seen == ["installing"]
    assert (env.data_dir / "resources" / "r1" / "tess" / "tesseract.exe").is_file()


def test_already_installed_download_is_a_noop(env):
    manager.set_catalog([entry()])
    env.blobs["https://github.com/x/f"] = FLAT
    install(env)
    assert len(env.calls) == 1
    r = env.post("/api/resources/r1/download", json={"accept_license": True})
    assert r.status_code == 200
    assert r.json() == {"already_installed": True, "message_ar": "مثبّت بالفعل", "job_id": None}
    # even without the licence tick: nothing is downloaded, so nothing to accept
    assert env.post("/api/resources/r1/download", json={}).json()["already_installed"] is True
    assert len(env.calls) == 1
    with pytest.raises(MizajError) as e:  # the manager itself refuses too
        manager.start_download(env.data_dir, env.data_dir / "mizaj.db", "r1", True)
    assert e.value.error_code == "ERR_ALREADY_INSTALLED"


def test_changed_catalog_hash_offers_update_and_keeps_user_choice(env):
    manager.set_catalog([entry()])
    env.blobs["https://github.com/x/f"] = FLAT
    install(env)
    env.post("/api/resources/r1/enabled", json={"enabled": False})
    new = b"newer dictionary"
    manager.set_catalog([entry(blob=new)])
    env.blobs["https://github.com/x/f"] = new
    assert item(env, "r1")["update_available"] is True
    r = env.post("/api/resources/r1/download", json={"accept_license": True})
    assert r.status_code == 202
    assert wait_job(env, r.json()["job_id"])["status"] == "done"
    it = item(env, "r1")
    assert it["update_available"] is False and it["enabled"] is False
    assert (env.data_dir / "resources" / "r1" / "f.bin").read_bytes() == new


def test_missing_files_mean_not_installed_and_download_allowed(env):
    manager.set_catalog([entry()])
    env.blobs["https://github.com/x/f"] = FLAT
    install(env)
    (env.data_dir / "resources" / "r1" / "f.bin").unlink()  # e.g. quarantined by antivirus
    assert item(env, "r1")["installed"] is None
    assert install(env)["status"] == "done"
    assert len(env.calls) == 2


def test_uninstall_deletes_files_and_reports_freed_bytes(env):
    manager.set_catalog([entry(blob=ZIP, extract_to="tess")])
    env.blobs["https://github.com/x/f"] = ZIP
    install(env)
    size = item(env, "r1")["installed_size"]
    assert size > 0
    out = env.delete("/api/resources/r1").json()
    assert out["uninstalled"] is True and out["freed_bytes"] == size
    assert not (env.data_dir / "resources" / "r1").exists()
    it = item(env, "r1")
    assert it["installed"] is None and it["installed_size"] is None
    assert env.delete("/api/resources/r1").json()["freed_bytes"] == 0  # idempotent
    assert env.delete("/api/resources/nope").status_code == 404
    # and a fresh download works again
    assert install(env)["status"] == "done"


def test_failed_download_is_an_error_state_and_retry_works(env, monkeypatch):
    manager.set_catalog([entry()])
    env.blobs["https://github.com/x/f"] = FLAT
    good = downloads.fetch

    def boom(*a, **k):
        raise MizajError("ERR_DOWNLOAD_FAILED", 502, "فشل", "boom", {})

    monkeypatch.setattr(downloads, "fetch", boom)
    job = install(env)
    assert job["status"] == "failed" and job["error"]["error_code"] == "ERR_DOWNLOAD_FAILED"
    assert item(env, "r1")["installed"] is None
    monkeypatch.setattr(downloads, "fetch", good)
    assert install(env)["status"] == "done"
    assert item(env, "r1")["enabled"] is True


def test_legacy_installed_json_without_flag_counts_as_enabled(env):
    manager.set_catalog([entry()])
    d = env.data_dir / "resources" / "r1"
    d.mkdir(parents=True)
    (d / "f.bin").write_bytes(FLAT)
    (d / "installed.json").write_text(json.dumps({"id": "r1", "sha256": entry()["sha256"]}))
    it = item(env, "r1")
    assert it["installed"] and it["enabled"] is True and it["update_available"] is False


def test_piper_respects_disabled_flag(env):
    from app.tts import piper

    exe = env.data_dir / "resources" / piper.ENGINE_ID / "piper" / "piper.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    (exe.parents[1] / "installed.json").write_text("{}")
    v = env.data_dir / "resources" / piper.VOICE_ID
    v.mkdir(parents=True)
    (v / piper.VOICE_FILE).write_bytes(b"x")
    (v / (piper.VOICE_FILE + ".json")).write_text("{}")
    assert piper.locate(env.data_dir) is not None
    (exe.parents[1] / "installed.json").write_text(json.dumps({"enabled": False}))
    assert piper.locate(env.data_dir) is None


# ---------------------------------------------------------------- detection of extracted tools
def test_extracted_tesseract_is_detected_after_install(env, monkeypatch):
    monkeypatch.delenv("MIZAJ_TESSERACT", raising=False)
    monkeypatch.setattr(discovery.shutil, "which", lambda n: None)
    monkeypatch.setattr(discovery, "WIN_TESSERACT", [])
    monkeypatch.setattr(discovery, "tesseract_languages", lambda b: ["ara", "eng"])
    assert env.get("/api/tools").json()["tesseract"]["detected"] is False
    manager.set_catalog([entry(blob=ZIP, extract_to="tess", kind="ocr-engine")])
    env.blobs["https://github.com/x/f"] = ZIP
    install(env)
    t = env.get("/api/tools").json()["tesseract"]
    assert t["detected"] is True and t["arabic"] is True
    assert t["path"].replace("\\", "/").endswith("/resources/r1/tess/" + Path(t["path"]).name)
    # OCR's own lookup (no explicit data dir) finds it too, and sets TESSDATA_PREFIX
    assert discovery.find_tesseract() == t["path"]
    assert discovery.tesseract_env(t["path"])["TESSDATA_PREFIX"].endswith("tessdata")


def test_extracted_languagetool_jar_and_java_are_found(env, monkeypatch):
    monkeypatch.setattr(discovery.shutil, "which", lambda n: None)
    base = env.data_dir / "resources" / "lt" / "LanguageTool-6.4"
    base.mkdir(parents=True)
    (base / "languagetool-server.jar").write_bytes(b"PK")
    jre = env.data_dir / "resources" / "jre" / "jdk-17" / "bin"
    jre.mkdir(parents=True)
    (jre / "java.exe").write_bytes(b"MZ")
    (jre / "java").write_bytes(b"ELF")
    lt = env.get("/api/tools").json()["languagetool"]
    assert lt["installed_files"] is True and lt["jar"].endswith("languagetool-server.jar")
    assert lt["java"] and "jdk-17" in lt["java"]
    assert lt["detected"] is False  # the server is not running: only the files are there
