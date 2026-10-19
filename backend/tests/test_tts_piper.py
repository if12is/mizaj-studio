# ruff: noqa: E501
"""Piper read-aloud (backend): process mocked, never a real piper.exe. The text is not logged."""

import hashlib
import io
import json
import logging
import subprocess
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.errors import MizajError
from app.resources import manager
from app.tts import piper

TEXT = "قَوْسُ قُزَحٍ ظَاهِرَةٌ طَبِيعِيَّةٌ"


def wav_bytes(n=200) -> bytes:
    return b"RIFF" + (36 + n).to_bytes(4, "little") + b"WAVEfmt " + bytes(24) + b"data" + bytes(n)


def install(data_dir: Path) -> Path:
    exe = data_dir / "resources" / piper.ENGINE_ID / "piper" / "piper.exe"
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"MZ")
    (data_dir / "resources" / piper.ENGINE_ID / "installed.json").write_text("{}")
    v = data_dir / "resources" / piper.VOICE_ID
    v.mkdir(parents=True)
    (v / piper.VOICE_FILE).write_bytes(b"onnx")
    (v / (piper.VOICE_FILE + ".json")).write_text("{}")
    return exe


class FakeRun:
    def __init__(self, wav=None, code=0, exc=None):
        self.wav, self.code, self.exc, self.calls = wav, code, exc, []

    def __call__(self, cmd, **kw):
        self.calls.append((cmd, kw))
        if self.exc:
            raise self.exc
        out = Path(cmd[cmd.index("--output_file") + 1])
        if self.wav is not None:
            out.write_bytes(self.wav)
        return SimpleNamespace(returncode=self.code)


def test_text_goes_to_stdin_not_argv_and_temp_is_removed(data_dir):
    install(data_dir)
    run = FakeRun(wav_bytes())
    wav = piper.synthesize(data_dir, TEXT, 1.25, run=run)
    assert wav[:4] == b"RIFF"
    cmd, kw = run.calls[0]
    assert all("قَوْس" not in a for a in cmd)
    assert TEXT in kw["input"].decode("utf-8")
    assert cmd[cmd.index("--length_scale") + 1] == "1.250"
    assert not any((data_dir / "tts-tmp").iterdir())


def test_length_scale_is_clamped(data_dir):
    install(data_dir)
    run = FakeRun(wav_bytes())
    piper.synthesize(data_dir, "ا", 99, run=run)
    assert run.calls[0][0][run.calls[0][0].index("--length_scale") + 1] == "2.000"


def test_text_never_logged(data_dir, caplog):
    install(data_dir)
    caplog.set_level(logging.DEBUG)
    with pytest.raises(MizajError):
        piper.synthesize(data_dir, TEXT, 1, run=FakeRun(wav_bytes(), code=3))
    assert "قَوْس" not in caplog.text and "قوس" not in caplog.text


@pytest.mark.parametrize(
    ("run", "code", "http"),
    [
        (FakeRun(exc=FileNotFoundError()), "ERR_PIPER_BLOCKED", 409),
        (FakeRun(exc=subprocess.TimeoutExpired("p", 1)), "ERR_PIPER_TIMEOUT", 504),
        (FakeRun(exc=PermissionError(13, "denied")), "ERR_PIPER_SPAWN_FAILED", 500),
        (FakeRun(wav_bytes(), code=1), "ERR_PIPER_FAILED", 500),
        (FakeRun(None), "ERR_PIPER_FAILED", 500),
        (
            FakeRun(b"not a wav at all, definitely not riff data......................"),
            "ERR_PIPER_FAILED",
            500,
        ),
    ],
)
def test_failures_map_to_arabic_errors_and_clean_up(data_dir, run, code, http):
    install(data_dir)
    with pytest.raises(MizajError) as e:
        piper.synthesize(data_dir, TEXT, 1, run=run)
    assert e.value.error_code == code and e.value.status == http
    assert any("؀" <= ch <= "ۿ" for ch in e.value.message_ar)
    assert not any((data_dir / "tts-tmp").iterdir())


def test_defender_virus_error_is_blocked(data_dir):
    install(data_dir)
    exc = OSError(22, "virus")
    exc.winerror = 225
    with pytest.raises(MizajError) as e:
        piper.synthesize(data_dir, TEXT, 1, run=FakeRun(exc=exc))
    assert e.value.error_code == "ERR_PIPER_BLOCKED"


def test_missing_install_and_quarantine(data_dir):
    with pytest.raises(MizajError) as e:
        piper.synthesize(data_dir, TEXT, 1, run=FakeRun(wav_bytes()))
    assert e.value.error_code == "ERR_PIPER_MISSING"
    exe = install(data_dir)
    exe.unlink()  # Defender removed it after a successful install
    assert piper.status(data_dir)["engine_missing_after_install"] is True
    with pytest.raises(MizajError) as e:
        piper.synthesize(data_dir, TEXT, 1, run=FakeRun(wav_bytes()))
    assert e.value.error_code == "ERR_PIPER_BLOCKED"


def test_validation(data_dir):
    install(data_dir)
    with pytest.raises(MizajError):
        piper.synthesize(data_dir, "   ", 1, run=FakeRun(wav_bytes()))
    with pytest.raises(MizajError) as e:
        piper.synthesize(data_dir, "ا" * 3000, 1, run=FakeRun(wav_bytes()))
    assert e.value.error_code == "ERR_PAYLOAD_TOO_LARGE"


def test_fake_hook_needs_both_env_vars(data_dir, monkeypatch):
    monkeypatch.setenv("MIZAJ_E2E_FAKE_PIPER", "/bin/true")
    assert piper.fake_hook() is None and piper.status(data_dir)["available"] is False
    monkeypatch.setenv("MIZAJ_ALLOW_TEST_HOOKS", "1")
    assert piper.fake_hook() == "/bin/true" and piper.status(data_dir)["available"] is True


def test_api_status_and_synthesize(client, monkeypatch):
    assert client.get("/api/tts/piper/status").json()["available"] is False
    r = client.post("/api/tts/piper/synthesize", json={"text": TEXT})
    assert r.status_code == 409 and r.json()["error_code"] == "ERR_PIPER_MISSING"
    install(client.data_dir)
    monkeypatch.setattr(piper.subprocess, "run", FakeRun(wav_bytes()))
    r = client.post("/api/tts/piper/synthesize", json={"text": TEXT, "length_scale": 1.1})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert r.content[:4] == b"RIFF"
    assert (
        client.post("/api/tts/piper/synthesize", json={"text": TEXT, "length_scale": 0}).status_code
        == 422
    )


def test_settings_validation(client):
    assert client.put("/api/settings", json={"tts_engine": "piper"}).status_code == 200
    assert client.put("/api/settings", json={"tts_engine": "x"}).status_code == 422
    assert client.put("/api/settings", json={"tts_length_scale": "1.2"}).status_code == 200
    assert client.put("/api/settings", json={"tts_length_scale": "9"}).status_code == 422


# ---------------------------------------------------------------- catalog / extraction
def test_catalog_entries_are_pinned_and_hf_hosts_allowed():
    from app.resources import net

    cat = {r["id"]: r for r in manager.catalog()}
    eng, voice = cat[piper.ENGINE_ID], cat[piper.VOICE_ID]
    for r in (eng, voice, *voice["extra_files"]):
        assert len(r["sha256"]) == 64 and r["url"].startswith("https://") and r["size"] > 0
        assert net.host_allowed(r["url"].split("/")[2])
    assert eng["sha256"].startswith("f3c58906") and voice["sha256"].startswith("9e95cab0")
    assert "غير محدد" in voice["notice_ar"] and piper.ENGINE_ID in voice["requires"]


def make_zip(path: Path, names: dict[str, bytes]):
    with zipfile.ZipFile(path, "w") as z:
        for n, b in names.items():
            z.writestr(n, b)


def test_zip_extract_flattens_and_rejects_traversal(tmp_path):
    a = tmp_path / "a.zip"
    make_zip(a, {"piper/piper.exe": b"MZ", "piper/espeak-ng-data/x": b"1"})
    manager.zip_extract(a, tmp_path / "out" / "piper", 10_000)
    assert (tmp_path / "out" / "piper" / "piper.exe").read_bytes() == b"MZ"
    bad = tmp_path / "b.zip"
    make_zip(bad, {"../evil.txt": b"x"})
    with pytest.raises(MizajError):
        manager.zip_extract(bad, tmp_path / "o2", 10_000)
    assert not (tmp_path / "evil.txt").exists() and not (tmp_path / "o2.tmp").exists()
    big = tmp_path / "c.zip"
    make_zip(big, {"p/a": b"x" * 5000})
    with pytest.raises(MizajError):
        manager.zip_extract(big, tmp_path / "o3", 100)


def test_import_engine_zip_extracts_and_verifies(client):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("piper/piper.exe", b"MZ")
    blob = buf.getvalue()
    entry = {
        "id": "piper-engine-win", "name": "e", "kind": "tts-engine", "url": "https://github.com/x",
        "filename": "e.zip", "sha256": hashlib.sha256(blob).hexdigest(), "size": len(blob),
        "extract_to": "piper", "license": "MIT", "license_url": "http://x", "attribution": "a",
    }  # fmt: skip
    manager.set_catalog([entry])
    try:
        src = client.data_dir / "src.zip"
        src.write_bytes(blob)
        meta = manager.import_file(client.data_dir, "piper-engine-win", src, True)
        assert json.loads(json.dumps(meta))["extracted_to"].endswith("piper")
        assert (
            client.data_dir / "resources" / "piper-engine-win" / "piper" / "piper.exe"
        ).is_file()
    finally:
        manager.set_catalog(None)


def test_hugging_face_regional_cdn_hosts_are_allowed():
    from app.resources.net import host_allowed

    assert host_allowed("us.aws.cdn.hf.co")
    assert host_allowed("cas-bridge.xethub.hf.co")
    assert not host_allowed("evilhf.co")
    assert not host_allowed("hf.co.evil.com")
