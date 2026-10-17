"""Real-model tests: run only when backend/models/catt_eo/encoder.onnx is present."""

import json
import time
from pathlib import Path

import pytest

from app.engine import config
from app.engine.normalize import MARKS, strip_marks

pytestmark = pytest.mark.skipif(
    not config.model_present(), reason="CATT model not downloaded (scripts/download_models.py)"
)

SENTENCES = [
    "ذهب الولد إلى المدرسة",
    "إن اللغة العربية بحر زاخر بالبيان والبلاغة، ويعد ضبط الكلمات ركيزة أساسية.",
    "قال المعلم: اقرأوا الدرس! ثم كتبوا 3 صفحات (Chapter 4) بعناية.",
]


@pytest.fixture
def real(monkeypatch):
    monkeypatch.delenv("MIZAJ_ENGINE_MODE", raising=False)


def marks_count(t):
    return sum(c in MARKS for c in t)


@pytest.mark.parametrize("mode", ["fast", "accurate"])
@pytest.mark.parametrize("text", SENTENCES)
def test_real_engines_add_marks_keep_base_text(client, real, mode, text):
    r = client.post("/api/tashkeel", json={"text": text, "mode": mode})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["engine"] == ("catt" if mode == "accurate" else "mishkal")
    assert strip_marks(j["text"]) == text
    assert marks_count(j["text"]) >= len(text.split())
    # non-Arabic parts untouched
    if "Chapter" in text:
        assert "(Chapter 4)" in j["text"] and " 3 " in j["text"]


def test_real_catt_known_sentence(client, real):
    r = client.post("/api/tashkeel", json={"text": SENTENCES[0], "mode": "accurate"})
    assert r.json()["text"].startswith("ذَهَبَ الْوَلَدُ")
    assert r.json()["text"].endswith("الْمَدْرَسَةِ")


@pytest.mark.parametrize("morph", [True, False])
def test_real_morph_filter_toggle_is_lossless(client, real, morph):
    text = SENTENCES[1]
    r = client.post("/api/tashkeel", json={"text": text, "mode": "accurate", "morph_filter": morph})
    assert r.status_code == 200 and strip_marks(r.json()["text"]) == text


def test_real_partial_lock_preserved(client, real):
    text = "ذهب الوَلد إلى المدرسة"
    out = client.post("/api/tashkeel", json={"text": text, "mode": "accurate"}).json()["text"]
    assert "الوَلد" in out.replace("ْ", "") or "وَلَ" in out
    assert out.count("وَ") >= 1 and strip_marks(out) == strip_marks(text)


def test_real_stream_and_resume(client, real):
    text = Path(__file__).parent.joinpath("fixtures", "sample_long.txt").read_text("utf-8")[:2500]
    body = {"text": text, "mode": "accurate"}
    t0 = time.perf_counter()
    r1 = client.post("/api/tashkeel/stream", json=body)
    cold = time.perf_counter() - t0
    ev = [json.loads(b.split("data: ", 1)[1]) for b in r1.text.strip().split("\n\n")]
    assert ev[-1]["progress"] == 100
    rebuilt = "".join(e["text"] for e in ev[:-1])
    assert strip_marks(rebuilt) == strip_marks(text)
    r2 = client.post("/api/tashkeel/stream", json=body)
    ev2 = [json.loads(b.split("data: ", 1)[1]) for b in r2.text.strip().split("\n\n")]
    assert all(e["cached"] for e in ev2[:-1]) and cold > 0


def test_real_word_suggestions(client, real):
    r = client.get("/api/word-suggestions", params={"word": "علم"})
    assert r.status_code == 200
    forms = {s["diacritized"] for s in r.json()}
    assert "عِلْمٌ" in forms and all(strip_marks(f) == "علم" for f in forms)
    assert all(s["pos"] for s in r.json())
