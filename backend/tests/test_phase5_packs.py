import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from app.engine import config

ENVELOPE_KEYS = {"error_code", "message_ar", "message_en", "details"}


def make_pack(path: Path, members: dict[str, bytes], **over) -> Path:
    manifest = {
        "format": 1,
        "kind": "models",
        "version": "test-1",
        "files": [
            {"path": p, "sha256": hashlib.sha256(b).hexdigest(), "size": len(b)}
            for p, b in members.items()
        ],
    }
    manifest.update(over)
    with zipfile.ZipFile(path, "w") as z:
        if manifest is not None:
            z.writestr("manifest.json", json.dumps(manifest))
        for p, b in members.items():
            z.writestr(p, b)
    return path


FILES = {"catt_eo/encoder.onnx": b"ENCODER" * 100, "catt_eo/decoder.onnx": b"DEC" * 10}


@pytest.fixture
def no_dev_models(monkeypatch, tmp_path):
    monkeypatch.delenv("MIZAJ_MODELS_DIR", raising=False)
    monkeypatch.setattr(config, "CATT_DIR", tmp_path / "nodev")


def apply(client, p):
    return client.post("/api/packs/apply", json={"path": str(p)})


def test_valid_pack_apply_status_and_health(client, tmp_path, no_dev_models):
    assert client.get("/api/packs/status").json()["installed"] is False
    pack = make_pack(tmp_path / "m.mizajpack", FILES)
    r = apply(client, pack)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["applied"] and j["version"] == "test-1" and j["models_source"] == "data-dir"
    models = client.data_dir / "models" / "catt_eo"
    assert (models / "encoder.onnx").read_bytes() == FILES["catt_eo/encoder.onnx"]
    assert not [p for p in (client.data_dir / "models").iterdir() if p.name.startswith(".")]
    st = client.get("/api/packs/status").json()
    assert st["installed"] and st["version"] == "test-1" and st["model_present"]
    assert Path(st["models_dir"]) == models
    h = client.get("/health").json()
    assert Path(h["models_dir"]) == models


def test_apply_then_health_flips_to_real(client, tmp_path, monkeypatch, no_dev_models):
    monkeypatch.delenv("MIZAJ_ENGINE_MODE", raising=False)
    assert client.get("/health").json()["engine_mode"] == "mock"
    apply(client, make_pack(tmp_path / "m.mizajpack", FILES))
    assert client.get("/health").json()["engine_mode"] == "real"


def test_apply_replaces_existing_and_resets_engines(client, tmp_path, no_dev_models):
    from app.engine.manager import manager

    manager.get_sync("mock")
    assert (
        apply(client, make_pack(tmp_path / "a.mizajpack", FILES, version="v1")).status_code == 200
    )
    new = {"catt_eo/encoder.onnx": b"NEWER", "catt_eo/decoder.onnx": b"D2"}
    assert apply(client, make_pack(tmp_path / "b.mizajpack", new, version="v2")).status_code == 200
    d = client.data_dir / "models" / "catt_eo"
    assert (d / "encoder.onnx").read_bytes() == b"NEWER"
    assert client.get("/api/packs/status").json()["version"] == "v2"
    assert manager._engines == {}  # hot reload: engines rebuilt lazily


def test_bad_hash_leaves_existing_models_untouched(client, tmp_path, no_dev_models):
    apply(client, make_pack(tmp_path / "ok.mizajpack", FILES, version="good"))
    bad = tmp_path / "bad.mizajpack"
    make_pack(bad, {"catt_eo/encoder.onnx": b"EVIL", "catt_eo/decoder.onnx": b"x"})
    with zipfile.ZipFile(bad) as z:
        m = json.loads(z.read("manifest.json"))
    m["files"][0]["sha256"] = "0" * 64
    with zipfile.ZipFile(bad, "w") as z:
        z.writestr("manifest.json", json.dumps(m))
        z.writestr("catt_eo/encoder.onnx", b"EVIL")
        z.writestr("catt_eo/decoder.onnx", b"x")
    r = apply(client, bad)
    assert r.status_code == 422 and r.json()["error_code"] == "ERR_PACK_INVALID"
    assert set(r.json()) == ENVELOPE_KEYS
    d = client.data_dir / "models"
    assert (d / "catt_eo" / "encoder.onnx").read_bytes() == FILES["catt_eo/encoder.onnx"]
    assert client.get("/api/packs/status").json()["version"] == "good"
    assert not [p for p in d.iterdir() if p.name.startswith(".")]


@pytest.mark.parametrize(
    "evil", ["../evil.onnx", "/abs/evil.onnx", "catt_eo/../../evil", "a\\b.onnx"]
)
def test_zip_slip_rejected(client, tmp_path, evil, no_dev_models):
    pack = make_pack(tmp_path / "s.mizajpack", {evil: b"x"})
    r = apply(client, pack)
    assert r.status_code == 422 and r.json()["error_code"] == "ERR_PACK_INVALID"
    assert not (client.data_dir / "evil.onnx").exists() and not (tmp_path / "evil.onnx").exists()


def test_invalid_packs(client, tmp_path, no_dev_models):
    # missing manifest
    nm = tmp_path / "nm.mizajpack"
    with zipfile.ZipFile(nm, "w") as z:
        z.writestr("catt_eo/encoder.onnx", b"x")
    assert apply(client, nm).json()["error_code"] == "ERR_PACK_INVALID"
    # not a zip
    nz = tmp_path / "nz.mizajpack"
    nz.write_bytes(b"garbage")
    assert apply(client, nz).status_code == 422
    # wrong format / kind / empty / declared file missing / size mismatch
    for over in ({"format": 2}, {"kind": "app"}, {"files": []}, {"version": ""}):
        p = make_pack(tmp_path / "x.mizajpack", FILES, **over)
        assert apply(client, p).status_code == 422, over
    p = make_pack(tmp_path / "ms.mizajpack", FILES)
    with zipfile.ZipFile(p) as z:
        m = json.loads(z.read("manifest.json"))
    m["files"].append({"path": "catt_eo/ghost.onnx", "sha256": "0" * 64, "size": 1})
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("manifest.json", json.dumps(m))
        for k, v in FILES.items():
            z.writestr(k, v)
    assert apply(client, p).status_code == 422
    m["files"] = [{**m["files"][0], "size": 5}]
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("manifest.json", json.dumps(m))
        z.writestr(m["files"][0]["path"], FILES["catt_eo/encoder.onnx"])
    assert apply(client, p).status_code == 422
    assert client.get("/api/packs/status").json()["installed"] is False


def test_apply_path_validation(client, tmp_path):
    assert apply(client, "relative.mizajpack").status_code == 422
    assert apply(client, tmp_path / "x.zip").status_code == 422
    r = apply(client, tmp_path / "nope.mizajpack")
    assert r.status_code == 404 and r.json()["error_code"] == "ERR_NOT_FOUND"


def test_model_dir_resolution_order(tmp_path, monkeypatch):
    dev = tmp_path / "dev"
    data = tmp_path / "data"
    envd = tmp_path / "env"
    for d in (dev, data / "models" / "catt_eo", envd / "catt_eo"):
        d.mkdir(parents=True)
        (d / "encoder.onnx").write_bytes(b"x")
    monkeypatch.setattr(config, "CATT_DIR", dev)
    config.set_data_dir(data)
    monkeypatch.delenv("MIZAJ_MODELS_DIR", raising=False)
    assert config.resolve_model_dir() == ("data-dir", data / "models" / "catt_eo")
    monkeypatch.setenv("MIZAJ_MODELS_DIR", str(envd))
    assert config.resolve_model_dir() == ("env", envd / "catt_eo")
    monkeypatch.delenv("MIZAJ_MODELS_DIR")
    monkeypatch.setattr(config, "exe_dir", lambda: tmp_path / "exe")
    (tmp_path / "exe" / "models" / "catt_eo").mkdir(parents=True)
    (tmp_path / "exe" / "models" / "catt_eo" / "encoder.onnx").write_bytes(b"x")
    (data / "models" / "catt_eo" / "encoder.onnx").unlink()
    assert config.resolve_model_dir()[0] == "exe"
    (tmp_path / "exe" / "models" / "catt_eo" / "encoder.onnx").unlink()
    assert config.resolve_model_dir() == ("dev", dev)
    config.set_data_dir(None)


def test_make_mizajpack_script_roundtrip(client, tmp_path, no_dev_models):
    import subprocess
    import sys

    src = tmp_path / "src"
    src.mkdir()
    (src / "encoder.onnx").write_bytes(b"E" * 50)
    (src / "decoder.onnx").write_bytes(b"D" * 5)
    out = tmp_path / "s.mizajpack"
    script = Path(__file__).resolve().parents[2] / "scripts" / "make_mizajpack.py"
    subprocess.run(
        [sys.executable, str(script), "--src", str(src), "--version", "9", "-o", str(out)],
        check=True,
        capture_output=True,
    )
    r = apply(client, out)
    assert r.status_code == 200 and r.json()["version"] == "9"


def test_use_cache_false_bypasses_chunk_cache_only(client):
    client.post("/api/dictionary", json={"word_or_phrase": "كتاب", "diacritized_form": "كِتَابٌ"})
    body = {"text": "كتاب جديد", "use_cache": False}
    a = client.post("/api/tashkeel", json=body).json()["text"]
    b = client.post("/api/tashkeel", json=body).json()["text"]
    assert a == b and a.startswith("كِتَابٌ")  # dictionary still applies
    s = client.post("/api/tashkeel/stream", json=body).text
    assert '"cached": false' in s and '"cached": true' not in s
    # default (cache on): first run populates, second is cached
    client.post("/api/tashkeel/stream", json={"text": "كتاب جديد"})
    s2 = client.post("/api/tashkeel/stream", json={"text": "كتاب جديد"}).text
    assert '"cached": true' in s2
