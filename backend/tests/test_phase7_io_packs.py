# ruff: noqa: F811, E501
import hashlib
import json
import zipfile
from pathlib import Path

import pytest
from io_helpers import ioc, set_setting  # noqa: F401
from test_phase5_packs import FILES, make_pack

from app.packs2 import guards


def add_word(c, w, f):
    assert (
        c.post("/api/dictionary", json={"word_or_phrase": w, "diacritized_form": f}).status_code
        == 201
    )


def export(c, tmp, kinds=None, **kw):
    p = tmp / "out.mizajpack"
    body = {"target_path": str(p), "name": "t", "license": "CC0-1.0", **kw}
    if kinds:
        body["kinds"] = kinds
    r = c.post("/api/packs/v2/export", json=body)
    assert r.status_code == 200, r.text
    return p, r.json()


def make_v2(path: Path, files: dict[str, dict | bytes], kind="bundle", **over) -> Path:
    blobs = {
        n: (v if isinstance(v, bytes) else json.dumps(v, ensure_ascii=False).encode())
        for n, v in files.items()
    }
    m = {
        "format": 2, "kind": kind, "version": "1", "created_at": "2026-01-01T00:00:00Z",
        "license": "CC0-1.0",
        "files": [
            {"path": n, "kind": n.split(".")[0], "size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
            for n, b in blobs.items()
        ],
    }  # fmt: skip
    m.update(over)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("manifest.json", json.dumps(m))
        for n, b in blobs.items():
            z.writestr(n, b)
    return path


def test_dictionary_roundtrip_conflict_and_undo(ioc, tmp_path):
    add_word(ioc, "كتاب", "كِتَابٌ")
    add_word(ioc, "علم", "عِلْمٌ")
    pack, info = export(ioc, tmp_path, ["dictionary"])
    assert (
        info["manifest"]["kind"] == "dictionary" and info["manifest"]["entries"]["dictionary"] == 2
    )
    # locally: change one entry, delete the other
    eid = {e["word_or_phrase"]: e["id"] for e in ioc.get("/api/dictionary").json()}
    ioc.put(f"/api/dictionary/{eid['كتاب']}", json={"diacritized_form": "كُتُبٌ"})
    ioc.delete(f"/api/dictionary/{eid['علم']}")
    pv = ioc.post("/api/packs/v2/preview", json={"path": str(pack)}).json()
    d = pv["items"]["dictionary"]
    assert pv["license"] == "CC0-1.0" and pv["summary"]["dictionary"]["conflicts"] == 1
    assert [i["key"] for i in d["adds"]] == ["علم"]
    assert d["conflicts"][0]["reason"] == "user_locked"
    # default: user-locked wins
    r = ioc.post("/api/packs/v2/apply", json={"path": str(pack)}).json()
    forms = {e["word_or_phrase"]: e["diacritized_form"] for e in ioc.get("/api/dictionary").json()}
    assert forms == {"كتاب": "كُتُبٌ", "علم": "عِلْمٌ"}
    assert r["applied"]["dictionary"]["kept_local"] == 1
    # undo removes only what the import added
    u = ioc.post(f"/api/packs/v2/undo/{r['import_id']}").json()
    assert u["reverted"] == 1
    assert {e["word_or_phrase"] for e in ioc.get("/api/dictionary").json()} == {"كتاب"}
    assert (
        ioc.post(f"/api/packs/v2/undo/{r['import_id']}").json()["error_code"]
        == "ERR_IMPORT_ALREADY_UNDONE"
    )
    # explicit per-item override, then undo restores the previous local form
    r2 = ioc.post(
        "/api/packs/v2/apply",
        json={"path": str(pack), "decisions": {"dictionary": {"كتاب": "override"}}},
    ).json()
    forms = {e["word_or_phrase"]: e["diacritized_form"] for e in ioc.get("/api/dictionary").json()}
    assert forms["كتاب"] == "كِتَابٌ"
    ioc.post(f"/api/packs/v2/undo/{r2['import_id']}")
    forms = {e["word_or_phrase"]: e["diacritized_form"] for e in ioc.get("/api/dictionary").json()}
    assert forms == {"كتاب": "كُتُبٌ"}
    assert len(ioc.get("/api/packs/v2/imports").json()) == 2


def test_entry_validation_skips(ioc, tmp_path):
    guards.set_quran_checker(lambda t: t == "الرحمن")
    try:
        d = {"entries": [
            {"word_or_phrase": "كتاب", "diacritized_form": "كُتَّابٌ"},
            {"word_or_phrase": "كتاب", "diacritized_form": "كِتَابٌ"},
            {"word_or_phrase": "قلم", "diacritized_form": "قَلَمٍ"},
            {"word_or_phrase": "بيت", "diacritized_form": "بَابٌ"},
            {"word_or_phrase": "شمس", "diacritized_form": "شمس"},
            {"word_or_phrase": "الرحمن", "diacritized_form": "الرَّحْمَنُ"},
            {"word_or_phrase": "abc", "diacritized_form": "abc"},
        ]}  # fmt: skip
        p = make_v2(tmp_path / "d.mizajpack", {"dictionary.json": d}, kind="dictionary")
        items = ioc.post("/api/packs/v2/preview", json={"path": str(p)}).json()["items"][
            "dictionary"
        ]
        reasons = {i["key"] + ":" + i["reason"] for i in items["skips"]}
        assert {"كتاب:duplicate_in_pack", "بيت:base_letters_differ", "شمس:no_diacritics",
                "الرحمن:quran_text", "abc:not_arabic"} <= reasons  # fmt: skip
        assert {i["key"] for i in items["adds"]} == {"كتاب", "قلم"}
    finally:
        guards.set_quran_checker(None)


def test_bundle_glossary_templates_settings_and_private_excluded(ioc, tmp_path):
    set_setting(ioc, theme="light", online_resources="true")
    t = ioc.get("/api/legal/templates").json()
    assert t  # starter samples exist
    ioc.post("/api/legal/glossary", json={"term": "الكفالة", "diacritized": "الكَفَالَةُ"})
    pack, info = export(ioc, tmp_path)
    assert info["manifest"]["kind"] == "bundle"
    with zipfile.ZipFile(pack) as z:
        s = json.loads(z.read("settings.json"))["settings"]
        assert s["theme"] == "light" and not any(k.startswith("online_") for k in s)
        assert json.loads(z.read("templates.json"))["templates"] == []  # samples excluded
        g = json.loads(z.read("glossary.json"))["entries"]
        assert [e["term"] for e in g] == ["الكفالة"]
    # a fresh app: import the bundle
    ioc.delete(
        f"/api/legal/glossary/{ioc.get('/api/legal/glossary').json()['entries'][0]['id']}"
    ) if False else None
    set_setting(ioc, theme="dark")
    r = ioc.post("/api/packs/v2/apply", json={"path": str(pack)}).json()
    assert ioc.get("/api/settings").json()["theme"] == "light"
    ioc.post(f"/api/packs/v2/undo/{r['import_id']}")
    assert ioc.get("/api/settings").json()["theme"] == "dark"


def test_settings_pack_never_flips_online_switches(ioc, tmp_path):
    p = make_v2(
        tmp_path / "s.mizajpack",
        {
            "settings.json": {
                "settings": {"online_resources": "true", "theme": "light", "editor_font_size": "99"}
            }
        },
        kind="settings",
    )
    pv = ioc.post("/api/packs/v2/preview", json={"path": str(p)}).json()["items"]["settings"]
    assert {i["key"]: i["reason"] for i in pv["skips"]} == {
        "online_resources": "private_setting", "editor_font_size": "invalid_value"}  # fmt: skip
    ioc.post("/api/packs/v2/apply", json={"path": str(p)})
    s = ioc.get("/api/settings").json()
    assert s["theme"] == "light" and s.get("online_resources", "false") != "true"


def test_template_conflict_duplicate(ioc, tmp_path):
    tpl = {
        "name": "عقد",
        "category": "x",
        "body": "نص {{ a }}",
        "vars": [{"name": "a", "type": "text"}],
    }
    p = make_v2(
        tmp_path / "t.mizajpack", {"templates.json": {"templates": [tpl]}}, kind="templates"
    )
    assert ioc.post("/api/packs/v2/apply", json={"path": str(p)}).status_code == 200
    tpl2 = {**tpl, "body": "نص آخر {{ a }}"}
    p2 = make_v2(
        tmp_path / "t2.mizajpack", {"templates.json": {"templates": [tpl2]}}, kind="templates"
    )
    pv = ioc.post("/api/packs/v2/preview", json={"path": str(p2)}).json()["items"]["templates"]
    assert pv["conflicts"][0]["options"] == ["keep", "override", "duplicate"]
    r = ioc.post(
        "/api/packs/v2/apply",
        json={"path": str(p2), "decisions": {"templates": {"عقد|x": "duplicate"}}},
    ).json()
    names = [t["name"] for t in ioc.get("/api/legal/templates").json() if t["category"] == "x"]
    assert sorted(names) == ["عقد", "عقد (مستورد)"]
    ioc.post(f"/api/packs/v2/undo/{r['import_id']}")
    assert [t["name"] for t in ioc.get("/api/legal/templates").json() if t["category"] == "x"] == [
        "عقد"
    ]


@pytest.mark.parametrize(
    "case", ["slip", "abs", "sha", "extra", "nolic", "badjson", "toonew", "zipbomb", "notzip"]
)
def test_invalid_packs_rejected(ioc, tmp_path, case):
    good = {"entries": [{"word_or_phrase": "كتاب", "diacritized_form": "كِتَابٌ"}]}
    p = make_v2(tmp_path / "x.mizajpack", {"dictionary.json": good}, kind="dictionary")
    if case == "slip":
        p = make_v2(tmp_path / "x.mizajpack", {"../evil.json": good}, kind="dictionary")
    elif case == "abs":
        p = make_v2(tmp_path / "x.mizajpack", {"/evil.json": good}, kind="dictionary")
    elif case == "sha":
        b = json.dumps(good).encode()
        m = {"format": 2, "kind": "dictionary", "version": "1", "created_at": "z", "license": "x",
             "files": [{"path": "dictionary.json", "kind": "dictionary", "size": len(b), "sha256": "0" * 64}]}  # fmt: skip
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("manifest.json", json.dumps(m))
            z.writestr("dictionary.json", b)
    elif case == "extra":
        with zipfile.ZipFile(p, "a") as z:
            z.writestr("rogue.txt", "x")
    elif case == "nolic":
        p = make_v2(
            tmp_path / "x.mizajpack", {"dictionary.json": good}, kind="dictionary", license=""
        )
    elif case == "badjson":
        p = make_v2(tmp_path / "x.mizajpack", {"dictionary.json": b"{not json"}, kind="dictionary")
    elif case == "toonew":
        p = make_v2(
            tmp_path / "x.mizajpack",
            {"dictionary.json": good},
            kind="dictionary",
            min_app_version="99.0.0",
        )
    elif case == "zipbomb":
        big = {"entries": [{"word_or_phrase": "ا", "diacritized_form": "ا" * 10}]}
        p = make_v2(tmp_path / "x.mizajpack", {"dictionary.json": big}, kind="dictionary")
        info = json.loads(zipfile.ZipFile(p).read("manifest.json"))
        info["files"][0]["size"] = 10**12  # declared size lies
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("manifest.json", json.dumps(info))
            z.writestr("dictionary.json", json.dumps(big))
    else:
        p.write_bytes(b"not a zip")
    r = ioc.post("/api/packs/v2/preview", json={"path": str(p)})
    assert r.status_code == 422 and r.json()["error_code"] == "ERR_PACK_INVALID", r.text
    assert r.json()["message_ar"]


def test_v1_models_pack_backward_compatible(ioc, tmp_path, monkeypatch):
    from app.engine import config

    monkeypatch.delenv("MIZAJ_MODELS_DIR", raising=False)
    monkeypatch.setattr(config, "CATT_DIR", tmp_path / "nodev")
    p = make_pack(tmp_path / "m.mizajpack", FILES)
    pv = ioc.post("/api/packs/v2/preview", json={"path": str(p)}).json()
    assert pv["format"] == 1 and pv["kind"] == "models" and pv["models"]["files"] == 2
    r = ioc.post("/api/packs/v2/apply", json={"path": str(p)}).json()
    assert r["models"]["version"] == "test-1" and not r["undoable"]
    assert (ioc.data_dir / "models" / "catt_eo" / "encoder.onnx").exists()


def test_v2_models_pack(ioc, tmp_path):
    blobs = {"models/catt_eo/encoder.onnx": b"E" * 50}
    m = {"format": 2, "kind": "models", "version": "m2", "created_at": "z", "license": "Apache-2.0",
         "files": [{"path": n, "kind": "models", "size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
                   for n, b in blobs.items()]}  # fmt: skip
    p = tmp_path / "mm.mizajpack"
    with zipfile.ZipFile(p, "w") as z:
        z.writestr("manifest.json", json.dumps(m))
        for n, b in blobs.items():
            z.writestr(n, b)
    r = ioc.post("/api/packs/v2/apply", json={"path": str(p)}).json()
    assert r["models"]["version"] == "m2"
    assert (ioc.data_dir / "models" / "catt_eo" / "encoder.onnx").read_bytes() == b"E" * 50


# ------------------------------------------------------------------ backup
def test_backup_and_restore(ioc, tmp_path):
    add_word(ioc, "كتاب", "كِتَابٌ")
    res = ioc.data_dir / "resources" / "r1"
    res.mkdir(parents=True)
    (res / "f.txt").write_text("hello")
    bk = tmp_path / "all.mizajbackup"
    r = ioc.post("/api/backup/export", json={"target_path": str(bk)})
    assert r.status_code == 200 and bk.exists()
    ins = ioc.post("/api/backup/inspect", json={"path": str(bk)}).json()
    assert ins["restorable"] and ins["kind"] == "backup"
    # mutate state, then restore
    eid = ioc.get("/api/dictionary").json()[0]["id"]
    ioc.delete(f"/api/dictionary/{eid}")
    (res / "f.txt").write_text("changed")
    rr = ioc.post("/api/backup/restore", json={"path": str(bk)}).json()
    assert rr["status"] == "restored" and rr["safety_backup"]
    assert [e["word_or_phrase"] for e in ioc.get("/api/dictionary").json()] == ["كتاب"]
    assert (res / "f.txt").read_text() == "hello"
    assert not [p for p in ioc.data_dir.iterdir() if p.name.startswith((".restore", ".old"))]


def test_backup_tampered_is_rejected_and_nothing_changes(ioc, tmp_path):
    add_word(ioc, "كتاب", "كِتَابٌ")
    bk = tmp_path / "all.mizajbackup"
    ioc.post("/api/backup/export", json={"target_path": str(bk)})
    members = {n: zipfile.ZipFile(bk).read(n) for n in zipfile.ZipFile(bk).namelist()}
    members["db/mizaj.db"] = members["db/mizaj.db"][:-10] + b"X" * 10
    bad = tmp_path / "bad.mizajbackup"
    with zipfile.ZipFile(bad, "w") as z:
        for n, b in members.items():
            z.writestr(n, b)
    r = ioc.post("/api/backup/restore", json={"path": str(bad)})
    assert r.status_code == 422 and r.json()["error_code"] == "ERR_BACKUP_INVALID"
    assert len(ioc.get("/api/dictionary").json()) == 1
    with zipfile.ZipFile(tmp_path / "slip.mizajbackup", "w") as z:
        z.writestr("manifest.json", json.dumps({"format": 1, "kind": "backup", "files": [
            {"path": "../x", "size": 1, "sha256": "0" * 64}]}))  # fmt: skip
    r = ioc.post("/api/backup/restore", json={"path": str(tmp_path / "slip.mizajbackup")})
    assert r.status_code == 422


def test_pending_restore_marker(ioc, tmp_path):
    from app.packs2 import backup

    bk = tmp_path / "a.mizajbackup"
    add_word(ioc, "كتاب", "كِتَابٌ")
    ioc.post("/api/backup/export", json={"target_path": str(bk)})
    stage = backup.stage_restore(bk, ioc.data_dir)
    (ioc.data_dir / backup.MARKER).write_text(json.dumps({"stage": stage.name}))
    eid = ioc.get("/api/dictionary").json()[0]["id"]
    ioc.delete(f"/api/dictionary/{eid}")
    assert backup.apply_pending_restore(ioc.data_dir, ioc.data_dir / "mizaj.db")
    assert len(ioc.get("/api/dictionary").json()) == 1
