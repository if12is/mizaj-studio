"""Slice 7.4.1: Quran protection (detection index, API, spelling integration)."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import quran as quran_api
from app.api import spelling as spelling_api
from app.main import create_app
from app.quran import store
from app.quran.detect import QuranIndex, find_protected_spans, is_quran_text, qkey, reset_index

FIX = Path(__file__).parent / "fixtures" / "quran_mini.txt"
SHA = store._sha256_bytes(FIX.read_bytes())


@pytest.fixture(autouse=True)
def _fresh_index():
    reset_index()
    yield
    reset_index()


@pytest.fixture
def qc(tmp_path):
    app = create_app(tmp_path / "data")
    app.include_router(quran_api.router)
    app.include_router(spelling_api.router)
    with TestClient(app) as c:
        c.data_dir = tmp_path / "data"
        yield c


def installed(qc):
    # tiny fixture: bypass the full-file structural validation (the API always validates)
    store.install_quran_text(qc.data_dir, FIX, "uthmani", SHA, validate=False)
    r = qc.get("/api/quran/status")
    assert r.status_code == 200, r.text
    return r.json()


def test_normalization_unifies_forms():
    assert qkey("ٱلرَّحْمَٰنِ") == qkey("الرحمان") == qkey("الرحمن")
    assert qkey("أَنْعَمْتَ") == qkey("انعمت")
    assert qkey("ٱلضَّآلِّينَ") == qkey("الضالين")


def test_status_not_installed_then_installed(qc):
    s = qc.get("/api/quran/status").json()
    assert s["installed"] is False and "CC BY 3.0" in s["license"]
    assert (
        qc.post("/api/quran/detect", json={"text": "بسم الله الرحمن الرحيم"}).json()["installed"]
        is False
    )
    s = installed(qc)
    assert s["installed"] and s["verses"] == 11
    assert s["texts"]["uthmani"]["sha256"] == SHA and "Tanzil" in s["attribution"]
    assert s["attribution_ar"].startswith("نص القرآن الكريم من مشروع تنزيل Tanzil.net")


def test_install_is_verbatim_and_checksum_verified(qc):
    installed(qc)
    dest = store.quran_dir(qc.data_dir) / "quran-uthmani.txt"
    assert dest.read_bytes() == FIX.read_bytes()
    with pytest.raises(Exception) as e:
        store.install_quran_text(qc.data_dir, FIX, "simple", "0" * 64, validate=False)
    assert e.value.error_code == "ERR_QURAN_CHECKSUM"
    nope = str(FIX.parent / "nope.txt")
    r = qc.post("/api/quran/install", json={"kind": "simple", "source_path": nope})
    assert r.status_code == 404


def test_api_install_always_validates_structure(qc):
    r = qc.post("/api/quran/install", json={"kind": "uthmani", "source_path": str(FIX)})
    assert r.status_code == 422 and r.json()["error_code"] == "ERR_QURAN_INVALID"
    assert qc.get("/api/quran/status").json()["installed"] is False


def test_detects_plain_and_diacritized_verse(qc):
    installed(qc)
    text = "قال تعالى: الحمد لله رب العالمين، وهذا كلام عادي بعده."
    (sp,) = qc.post("/api/quran/detect", json={"text": text}).json()["spans"]
    assert sp["ref"] == "1:2" and sp["kind"] == "verse"
    assert text[sp["start"] : sp["end"]] == "الحمد لله رب العالمين"
    text2 = "ٱلْحَمْدُ لِلَّهِ رَبِّ ٱلْعَٰلَمِينَ"
    (sp2,) = qc.post("/api/quran/detect", json={"text": text2}).json()["spans"]
    assert (sp2["start"], sp2["end"]) == (0, len(text2))


def test_ordinary_text_is_not_flagged(qc):
    installed(qc)
    text = "ذهب الولد إلى المدرسة وقرأ الكتاب الجديد ثم عاد إلى البيت مع أصدقائه"
    assert qc.post("/api/quran/detect", json={"text": text}).json()["spans"] == []
    # three words shared with a verse are below the 4-word threshold
    assert qc.post("/api/quran/detect", json={"text": "الحمد لله رب"}).json()["spans"] == []


def test_short_verse_only_inside_brackets(qc):
    installed(qc)
    assert qc.post("/api/quran/detect", json={"text": "قل هو الله أحد"}).json()["spans"][0]["ref"]
    assert qc.post("/api/quran/detect", json={"text": "الله الصمد"}).json()["spans"] == []
    res = qc.post("/api/quran/detect", json={"text": "قال ﴿ الله الصمد ﴾ تعالى"}).json()
    assert res["spans"][0]["ref"] == "112:2" and res["spans"][0]["bracketed"] is True


def test_partial_quotation_and_one_word_gap(qc):
    installed(qc)
    text = "يقول المصلي إياك نعبد وإياك نستعين في كل ركعة"
    (sp,) = qc.post("/api/quran/detect", json={"text": text}).json()["spans"]
    assert sp["ref"] == "1:5" and text[sp["start"] : sp["end"]] == "إياك نعبد وإياك نستعين"
    # one misspelled word inside a longer verse does not break the match
    t2 = "صراط الذين انعمت عليهم غير المغظوب عليهم ولا الضالين"
    (sp2,) = qc.post("/api/quran/detect", json={"text": t2}).json()["spans"]
    assert sp2["ref"] == "1:7" and sp2["kind"] == "verse"
    t3 = "قال: صراط الذين انعمت عليهم فقط"
    (sp3,) = qc.post("/api/quran/detect", json={"text": t3}).json()["spans"]
    assert sp3["kind"] == "partial" and sp3["needs_confirmation"] is True


def test_consecutive_verses_and_utf16_offsets(qc):
    installed(qc)
    text = "😀 الرحمن الرحيم مالك يوم الدين"
    res = qc.post("/api/quran/detect", json={"text": text}).json()
    sp = res["spans"][0]
    assert text[sp["start"] : sp["end"]] == sp["word"]
    assert sp["start16"] == sp["start"] + 1  # the emoji is 2 UTF-16 units, 1 code point


def test_find_protected_spans_api(qc):
    installed(qc)
    text = "مقدمة. بسم الله الرحمن الرحيم. خاتمة."
    spans = find_protected_spans(text, qc.data_dir)
    assert len(spans) == 1 and text[spans[0][0] : spans[0][1]] == "بسم الله الرحمن الرحيم"
    assert find_protected_spans("نص عادي بلا آيات", qc.data_dir) == []
    assert find_protected_spans("", qc.data_dir) == []


def test_find_protected_spans_without_text_is_empty(tmp_path):
    assert find_protected_spans("بسم الله الرحمن الرحيم", tmp_path) == []


def test_spelling_skips_quran_spans(qc):
    text = "الحمد لله رب العالمين وهاذا كتاب"
    before = qc.post("/api/spelling/check", json={"text": text}).json()
    assert before["issues"]
    # make a misspelling *inside* a verse text unflagged: protect "ولا الضالين" quoted with a typo
    quote = "ٱهدنا الصراط المستقيم صراط الذين انعمت عليهم غير المغضوب عليهم ولا الضالين"
    inner = "هاذا " + quote
    installed(qc)
    after = qc.post("/api/spelling/check", json={"text": inner}).json()
    assert all(i["end"] <= len("هاذا ") or i["start"] >= 0 for i in after["issues"])
    words = {i["word"] for i in after["issues"]}
    assert "هاذا" in words  # outside the verse still checked
    assert not words & {"انعمت", "الصراط", "الضالين"}  # inside: protected


def test_index_builds_from_both_texts_without_duplicates(tmp_path):
    idx = QuranIndex()
    assert idx.add_file(FIX) == 11
    assert idx.add_file(FIX) == 0  # identical normalized verses are not re-added


def test_multi_verse_ref(qc):
    installed(qc)
    text = "قال: الرحمن الرحيم مالك يوم الدين"
    (sp,) = qc.post("/api/quran/detect", json={"text": text}).json()["spans"]
    assert sp["ref"] == "1:3-4"


def test_is_quran_text(qc):
    assert is_quran_text("بسم الله الرحمن الرحيم") is False  # nothing installed
    installed(qc)
    assert is_quran_text("بسم الله الرحمن الرحيم", qc.data_dir) is True
    assert is_quran_text("إياك نعبد وإياك نستعين") is True  # remembers the data dir
    assert is_quran_text("ذهب الولد إلى المدرسة صباحا") is False
    assert is_quran_text("") is False


# ------------------------------------------------------------------ Tanzil structure / download
def synthetic_tanzil(notice=True, drop=None, swap=False):
    """6236 synthetic `sura|aya|text` lines (NOT real Quran text) + a Tanzil-style notice."""
    lines = []
    for sura, n in enumerate(store.VERSE_COUNTS, 1):
        for aya in range(1, n + 1):
            lines.append(f"{sura}|{aya}|كلمة{sura} كلمة{aya}")
    if drop:
        lines.pop(drop)
    if swap:
        lines[10], lines[11] = lines[11], lines[10]
    if notice:
        lines += [
            "",
            "# Tanzil Quran Text",
            "# License: Creative Commons Attribution 3.0",
            "# Copyright (C) 2007-2021 Tanzil Project",
        ]
    return "\n".join(lines) + "\n"


def test_canonical_table():
    assert len(store.VERSE_COUNTS) == 114 and sum(store.VERSE_COUNTS) == store.TOTAL_VERSES


def test_validator_accepts_synthetic_and_rejects_damage():
    rep = store.validate_tanzil_text(synthetic_tanzil())
    assert rep["verses"] == 6236 and "Tanzil" in rep["notice"]
    for bad in (
        synthetic_tanzil(notice=False),
        synthetic_tanzil(drop=500),
        synthetic_tanzil(swap=True),
        "garbage line\n" + synthetic_tanzil(),
    ):
        with pytest.raises(Exception) as e:
            store.validate_tanzil_text(bad)
        assert e.value.error_code == "ERR_QURAN_INVALID"


def enable_online(qc):
    qc.put("/api/settings", json={"online_resources": "true"})


def test_download_requires_opt_in_and_posts_documented_form(qc):
    calls = []

    def post(url, fields):
        calls.append((url, fields))
        return synthetic_tanzil().encode()

    with pytest.raises(Exception) as e:
        store.download_quran_text(qc.data_dir, qc.app.state.db_path, post=post)
    assert e.value.error_code == "ERR_ONLINE_DISABLED" and calls == []
    enable_online(qc)
    out = store.download_quran_text(qc.data_dir, qc.app.state.db_path, post=post)
    assert set(out) == {"uthmani", "simple-clean"}
    assert calls[0][0] == "https://tanzil.net/pub/download/index.php"
    assert calls[0][1] == {
        "quranType": "uthmani",
        "outType": "txt-2",
        "agree": "true",
        "marks": "true",
        "sajdah": "true",
        "rub": "true",
        "alef": "true",
    }
    assert calls[1][1] == {"quranType": "simple-clean", "outType": "txt-2", "agree": "true"}
    raw = synthetic_tanzil().encode()
    assert out["uthmani"].read_bytes() == raw  # byte-for-byte
    meta = store.status(qc.data_dir)["texts"]["uthmani"]
    assert meta["sha256"] == store._sha256_bytes(raw) and meta["source_url"].startswith(
        "https://tanzil.net"
    )
    assert "Creative Commons" in meta["notice"] and meta["downloaded_at"]


def test_download_rejects_altered_file_and_keeps_previous(qc):
    enable_online(qc)
    store.download_quran_text(
        qc.data_dir, qc.app.state.db_path, post=lambda u, f: synthetic_tanzil().encode()
    )
    before = (store.quran_dir(qc.data_dir) / "quran-uthmani.txt").read_bytes()
    with pytest.raises(Exception) as e:
        store.download_quran_text(
            qc.data_dir, qc.app.state.db_path, post=lambda u, f: synthetic_tanzil(drop=3).encode()
        )
    assert e.value.error_code == "ERR_QURAN_INVALID"
    assert (store.quran_dir(qc.data_dir) / "quran-uthmani.txt").read_bytes() == before


def test_default_post_only_reaches_tanzil_host(qc):
    with pytest.raises(Exception) as e:
        store._default_post("https://evil.example.com/x", {})
    assert e.value.error_code == "ERR_HOST_NOT_ALLOWED"


def test_manual_install_through_api_validates_and_is_verbatim(qc, tmp_path):
    f = tmp_path / "quran-uthmani.txt"
    f.write_bytes(synthetic_tanzil().encode())
    r = qc.post("/api/quran/install", json={"kind": "uthmani", "source_path": str(f)})
    assert r.status_code == 200 and r.json()["installed"] is True
    assert (store.quran_dir(qc.data_dir) / "quran-uthmani.txt").read_bytes() == f.read_bytes()
    f.write_bytes(synthetic_tanzil(drop=9).encode())
    r = qc.post("/api/quran/install", json={"kind": "simple-clean", "source_path": str(f)})
    assert r.status_code == 422


def test_download_endpoint_disabled_by_default(qc):
    r = qc.post("/api/quran/download", json={})
    assert r.status_code == 403 and r.json()["error_code"] == "ERR_ONLINE_DISABLED"


def test_bom_file_installs_and_is_detected(qc, tmp_path):
    f = tmp_path / "bom.txt"
    f.write_bytes(b"\xef\xbb\xbf" + synthetic_tanzil().encode())
    r = qc.post("/api/quran/install", json={"kind": "uthmani", "source_path": str(f)})
    assert r.status_code == 200 and r.json()["verses"] == 6236


def test_quran_errors_are_specific_arabic_messages(qc, tmp_path):
    plain = tmp_path / "plain.txt"
    plain.write_text("بسم الله الرحمن الرحيم\n", encoding="utf-8")
    r = qc.post("/api/quran/install", json={"kind": "uthmani", "source_path": str(plain)})
    assert r.status_code == 422 and "with aya numbers" in r.json()["message_ar"]
    short = tmp_path / "short.txt"
    short.write_bytes(synthetic_tanzil(drop=500).encode())
    r = qc.post("/api/quran/install", json={"kind": "uthmani", "source_path": str(short)})
    assert "6236" in r.json()["message_ar"]


def test_unreachable_tanzil_gives_actionable_arabic_not_raw_error(qc, monkeypatch):
    enable_online(qc)
    monkeypatch.setattr(store.time, "sleep", lambda s: None)

    def down(*a, **k):
        raise OSError("Network is unreachable")

    monkeypatch.setattr(store.urllib.request, "build_opener", down)
    r = qc.post("/api/quran/download", json={})
    assert r.status_code == 502 and r.json()["error_code"] == "ERR_QURAN_DOWNLOAD"
    ar = r.json()["message_ar"]
    assert "tanzil.net" in ar and "تثبيت من ملف" in ar
    assert "Network" not in ar
