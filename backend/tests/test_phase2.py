import asyncio
import json
import threading
import time
from pathlib import Path

import httpx
import pytest

from app.core.database import connect
from app.engine import config
from app.engine.cache import TashkeelCache
from app.engine.chunk_map import ChunkMap
from app.engine.manager import manager
from app.engine.mock_engine import MockEngine
from app.engine.morph_filter import MorphFilter
from app.engine.normalize import reduce_level, strip_marks
from app.engine.partial_lock import PartialDiacritizationLock
from app.engine.pipeline import TashkeelPipeline
from app.engine.splitter import ArabicSentenceSplitter
from app.main import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "sample_long.txt"
ENVELOPE_KEYS = {"error_code", "message_ar", "message_en", "details"}
FATHA, DAMMA, SHADDA = "َ", "ُ", "ّ"


def parse_sse(body: str):
    events = []
    for block in body.strip().split("\n\n"):
        name, data = "message", None
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
        events.append((name, data))
    return events


# ---------- mock vowelizer ----------
def test_mock_exact_outputs():
    m = MockEngine()
    assert m.vowelize_text("كتاب") == "كَتابُ"
    assert m.vowelize_text("ذهب الولد") == "ذَهبُ اَلولدُ"
    # strips existing marks first; non-Arabic untouched
    assert m.vowelize_text("كِتَابٌ and 123, ok!") == "كَتابُ and 123, ok!"
    assert m.vowelize_text("") == ""


def test_mock_uses_cache_lookup():
    m = MockEngine()
    out = m.vowelize_text("كتاب قلم", lookup=lambda ws: {"كتاب": "كِتَابٌ"})
    assert out == "كِتَابٌ قَلمُ"


def test_mock_is_deterministic():
    m = MockEngine()
    assert m.diacritize(["علم", "ب"]) == m.diacritize(["علم", "ب"]) == ["عَلمُ", "بَ"]


# ---------- partial lock ----------
def test_partial_lock_roundtrip():
    src = "كِتَابٌ جَميل والولد"
    stripped, lock = PartialDiacritizationLock.capture(src)
    assert stripped == strip_marks(src) and len(lock) > 0
    engine_out = MockEngine().vowelize_text(stripped)
    final = lock.apply(engine_out)
    assert strip_marks(final) == stripped
    assert final.startswith("كِتَابٌ جَميل")
    # unlocked tail comes from the engine
    assert final.endswith(MockEngine().vowelize_text("والولد"))


def test_partial_lock_empty_is_noop():
    stripped, lock = PartialDiacritizationLock.capture("كتاب")
    assert len(lock) == 0 and lock.apply("كَتابُ") == "كَتابُ"


# ---------- splitter / chunk map ----------
def test_splitter_properties_on_long_sample():
    text = FIXTURE.read_text(encoding="utf-8")
    chunks = ArabicSentenceSplitter().split(text)
    assert chunks and all(len(c.text) <= 256 for c in chunks)
    assert "".join(c.text for c in chunks) == text
    for a, b in zip(chunks, chunks[1:], strict=False):
        assert a.end == b.start
        # never cuts a word
        assert a.text[-1].isspace() or b.text[0].isspace() or a.text[-1] in ".؟!؛،,?;\n"


def test_splitter_edge_cases():
    sp = ArabicSentenceSplitter(max_chars=20)
    assert sp.split("") == []
    t = "مرحبا بالعالم. كيف حالك؟ أنا بخير، شكرا\nجزيلا لك يا صديقي"
    ch = sp.split(t)
    assert "".join(c.text for c in ch) == t and all(len(c.text) <= 20 for c in ch)
    assert ch[0].text.startswith("مرحبا") and ch[0].text.rstrip().endswith("بالعالم.")
    long_word = "ا" * 50
    assert "".join(c.text for c in sp.split(long_word)) == long_word


def test_chunk_map_lossless():
    text = FIXTURE.read_text(encoding="utf-8")[:5000]
    cmap = ChunkMap.build(text)
    outs = {c.index: MockEngine().vowelize_text(c.text) for c in cmap.chunks}
    result = cmap.assemble(outs)
    assert cmap.is_lossless(result) and strip_marks(result) == strip_marks(text)
    assert cmap.assemble({}) == text
    with pytest.raises(ValueError):
        ChunkMap("abc", [])


# ---------- cache ----------
@pytest.fixture
def conn(data_dir):
    create_app(data_dir)
    c = connect(data_dir / "mizaj.db")
    yield c
    c.close()


def test_cache_locked_wins_and_usage_count(conn):
    conn.execute(
        "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form, source, is_user_locked)"
        " VALUES ('كتاب','كِتَابٌ','user',1)"
    )
    pipe = TashkeelPipeline(MockEngine())
    r = pipe.process_chunk(conn, "هذا كتاب وكتاب")
    assert "كِتَابٌ" in r.text and r.text.count("كِتَابٌ") == 1  # 'وكتاب' is another word
    row = conn.execute("SELECT usage_count FROM tashkeel_cache WHERE word_or_phrase='كتاب'")
    assert row.fetchone()[0] == 2  # 1 default + 1 occurrence
    pipe.process_chunk(conn, "كتاب")
    assert (
        conn.execute("SELECT usage_count FROM tashkeel_cache WHERE is_user_locked=1").fetchone()[0]
        == 3
    )


def test_cache_chunk_hit_bumps_usage_and_never_overwrites_locked(conn):
    pipe = TashkeelPipeline(MockEngine())
    first = pipe.process_chunk(conn, "ذهب الولد")
    second = pipe.process_chunk(conn, "ذهب الولد")
    assert not first.cached and second.cached and first.text == second.text
    row = conn.execute(
        "SELECT source, is_user_locked, usage_count FROM tashkeel_cache "
        "WHERE word_or_phrase LIKE ?",
        ("%chunk:%",),
    ).fetchone()
    assert (row[0], row[1], row[2]) == ("engine", 0, 2)
    # locked row with the same key must never be overwritten
    cache = TashkeelCache(conn)
    conn.execute(
        "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form, source, "
        "is_user_locked) VALUES ('w','WW','user',1)"
    )
    cache.put_entry("w", "engine-form")
    assert (
        conn.execute(
            "SELECT diacritized_form FROM tashkeel_cache WHERE " "word_or_phrase='w'"
        ).fetchone()[0]
        == "WW"
    )


def test_cache_word_level_for_mock(conn):
    conn.execute(
        "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form) " "VALUES ('قلم','قَلَمٌ')"
    )
    r = TashkeelPipeline(MockEngine()).process_chunk(conn, "قلم")
    assert r.text == "قَلَمٌ"


def test_levels():
    full = "كَتَّبَ الْوَلَدُ دَرْسًا"
    assert reduce_level(full, "irab_only") == "كتبَ الولدُ درسًا"
    assert reduce_level(full, "minimal") == full  # minimal is applied by the pipeline
    assert reduce_level(full, "full") == full


def test_minimal_level_mock_rule(conn):
    """Mock rule: only 3-letter (triliteral) words are 'ambiguous' and get diacritized."""
    eng = MockEngine()
    pipe = TashkeelPipeline(eng, level="minimal", ambiguity=eng.is_ambiguous)
    r = pipe.process_chunk(conn, "علم كتاب ذهب المدرسة")
    assert r.text == "عَلمُ كتاب ذَهبُ المدرسة"
    with pytest.raises(RuntimeError):
        TashkeelPipeline(eng, level="minimal").process_chunk(conn, "علم")


# ---------- pipeline via API ----------
def test_api_tashkeel_mock(client):
    r = client.post("/api/tashkeel", json={"text": "كتاب جديد، and 5 !"})
    assert r.status_code == 200
    j = r.json()
    assert j["text"] == "كَتابُ جَديدُ، and 5 !" and j["engine"] == "mock"
    assert isinstance(j["elapsed_ms"], int)


def test_api_keep_existing_and_level(client):
    r = client.post("/api/tashkeel", json={"text": "كِتاب جديد"})
    assert r.json()["text"] == "كِتابُ جَديدُ"
    r = client.post("/api/tashkeel", json={"text": "كِتاب جديد", "keep_existing": False})
    assert r.json()["text"] == "كَتابُ جَديدُ"
    r = client.post("/api/tashkeel", json={"text": "كتاب جديد", "level": "irab_only"})
    assert r.json()["text"] == "كتابُ جديدُ"
    assert client.post("/api/tashkeel", json={"text": "x", "level": "bad"}).status_code == 422
    assert client.post("/api/tashkeel", json={"text": "x", "mode": "turbo"}).status_code == 422


def test_api_user_dictionary_wins(client):
    client.post("/api/dictionary", json={"word_or_phrase": "كتاب", "diacritized_form": "كِتَابٌ"})
    r = client.post("/api/tashkeel", json={"text": "كتاب", "level": "minimal"})
    assert r.json()["text"] == "كِتَابٌ"  # dictionary wins even when minimal leaves it bare
    r = client.post("/api/tashkeel", json={"text": "كتاب علم ذهب", "level": "minimal"})
    assert r.json()["text"] == "كِتَابٌ عَلمُ ذَهبُ"
    lst = client.get("/api/dictionary").json()
    assert lst[0]["usage_count"] == 3


# ---------- SSE ----------
def test_sse_format_progress_and_resume(client):
    text = FIXTURE.read_text(encoding="utf-8")[:6000]
    r = client.post("/api/tashkeel/stream", json={"text": text, "mode": "fast"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/event-stream")
    ev = parse_sse(r.text)
    chunks, (last_name, done) = ev[:-1], ev[-1]
    assert last_name == "done" and done["progress"] == 100 and done["chunks"] == len(chunks)
    assert all(n == "message" for n, _ in chunks)
    keys = {"chunk_id", "start", "end", "text", "progress", "wps", "cached"}
    assert all(set(d) == keys for _, d in chunks)
    progress = [d["progress"] for _, d in chunks]
    assert progress == sorted(progress) and progress[-1] == 100
    assert [d["chunk_id"] for _, d in chunks] == list(range(1, len(chunks) + 1))
    # replacing each chunk range by its text rebuilds the diacritized document losslessly
    rebuilt = "".join(d["text"] for _, d in chunks)
    assert strip_marks(rebuilt) == strip_marks(text)
    assert [d["start"] for _, d in chunks][0] == 0 and chunks[-1][1]["end"] == len(text)
    # resume: second run is served entirely from cache
    ev2 = parse_sse(client.post("/api/tashkeel/stream", json={"text": text}).text)
    assert all(d["cached"] is True for _, d in ev2[:-1])
    assert ev2[-1][1]["cached_chunks"] == len(ev2) - 1
    assert "".join(d["text"] for _, d in ev2[:-1]) == rebuilt


def test_sse_empty_and_unknown_document(client):
    ev = parse_sse(client.post("/api/tashkeel/stream", json={"text": ""}).text)
    assert ev == [("done", ev[0][1])] and ev[0][1]["chunks"] == 0
    r = client.post("/api/tashkeel/stream", json={"text": "كتاب", "document_id": 999})
    assert r.status_code == 404 and set(r.json()) == ENVELOPE_KEYS


def test_sse_error_event_on_engine_failure(client, monkeypatch):
    def boom(self, words, lookup=None):
        raise RuntimeError("boom")

    monkeypatch.setattr(MockEngine, "diacritize", boom)
    ev = parse_sse(client.post("/api/tashkeel/stream", json={"text": "كتاب"}).text)
    assert ev[-1][0] == "error" and set(ev[-1][1]) == ENVELOPE_KEYS


def test_health_responsive_during_stream(data_dir, monkeypatch):
    orig = MockEngine.diacritize

    def slow(self, words, lookup=None):
        time.sleep(0.08)
        return orig(self, words, lookup)

    monkeypatch.setattr(MockEngine, "diacritize", slow)
    app = create_app(data_dir)
    text = ". ".join(f"جملة رقم {chr(0x0661 + i % 9)} من النص الطويل" for i in range(120))

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as c:
            task = asyncio.create_task(
                c.post("/api/tashkeel/stream", json={"text": text * 4}, timeout=60)
            )
            await asyncio.sleep(0.3)
            assert not task.done(), "stream finished too early to test concurrency"
            lat = []
            for _ in range(5):
                t0 = time.perf_counter()
                assert (await c.get("/health")).status_code == 200
                lat.append(time.perf_counter() - t0)
                await asyncio.sleep(0.05)
            resp = await task
            return max(lat), resp

    worst, resp = asyncio.run(scenario())
    assert worst < 1.0  # generous for slow CI runners
    assert parse_sse(resp.text)[-1][0] == "done"


def test_engine_calls_run_in_executor_threads(client, monkeypatch):
    seen = []
    orig = MockEngine.diacritize

    def spy(self, words, lookup=None):
        seen.append(threading.current_thread().name)
        return orig(self, words, lookup)

    monkeypatch.setattr(MockEngine, "diacritize", spy)
    client.post("/api/tashkeel", json={"text": "كتاب"})
    client.get("/api/word-suggestions", params={"word": "علم"})
    assert seen and all(n.startswith("mizaj-engine") for n in seen)
    from app.engine import executor

    assert executor.get_executor()._max_workers == 2


# ---------- word suggestions ----------
def test_word_suggestions_exact_mock(client):
    r = client.get("/api/word-suggestions", params={"word": "علم"})
    assert r.status_code == 200
    assert r.json() == [
        {"diacritized": "عِلْمٌ", "pos": "اسم - مرفوع"},
        {"diacritized": "عَلِمَ", "pos": "فعل ماض"},
        {"diacritized": "عَلَمٌ", "pos": "اسم"},
    ]
    r = client.get("/api/word-suggestions", params={"word": "كتاب"})
    assert (
        len(r.json()) == 3
        and r.json() == client.get("/api/word-suggestions", params={"word": "كتاب"}).json()
    )


def test_word_suggestions_locked_first_and_validation(client):
    client.post("/api/dictionary", json={"word_or_phrase": "علم", "diacritized_form": "عُلِمَ"})
    j = client.get("/api/word-suggestions", params={"word": "علم"}).json()
    assert j[0] == {"diacritized": "عُلِمَ", "pos": "قاموس المستخدم"} and len(j) == 4
    for bad in ("", "hello", "كلمتان اثنتان"):
        r = client.get("/api/word-suggestions", params={"word": bad})
        assert r.status_code == 422 and r.json()["error_code"] == "ERR_VALIDATION"


# ---------- engine state / errors ----------
def test_accurate_model_missing_when_not_mock(client, monkeypatch, tmp_path):
    monkeypatch.delenv("MIZAJ_ENGINE_MODE", raising=False)
    monkeypatch.setattr(config, "CATT_DIR", tmp_path / "nope")
    r = client.post("/api/tashkeel", json={"text": "كتاب", "mode": "accurate"})
    assert r.status_code == 500 and r.json()["error_code"] == "ERR_MODEL_MISSING"
    assert set(r.json()) == ENVELOPE_KEYS
    r = client.post("/api/tashkeel/stream", json={"text": "كتاب", "mode": "accurate"})
    assert r.status_code == 500 and r.json()["error_code"] == "ERR_MODEL_MISSING"
    assert client.get("/health").json()["engine_mode"] == "mock"


def test_engine_not_ready_while_loading(client):
    manager._loading.add("mock")
    r = client.post("/api/tashkeel", json={"text": "كتاب"})
    assert r.status_code == 503 and r.json()["error_code"] == "ERR_ENGINE_NOT_READY"
    manager._loading.discard("mock")
    assert client.post("/api/tashkeel", json={"text": "كتاب"}).status_code == 200


def test_engine_loaded_once_thread_safe():
    built = []
    orig = manager._build

    def counting(key):
        built.append(key)
        time.sleep(0.05)
        return orig(key)

    manager._build = counting
    try:
        ts = [threading.Thread(target=manager.get_sync, args=("mock",)) for _ in range(6)]
        [t.start() for t in ts]
        [t.join() for t in ts]
    finally:
        del manager._build
    assert built == ["mock"]


def test_fast_mode_real_uses_mishkal_fallback(client, monkeypatch):
    monkeypatch.delenv("MIZAJ_ENGINE_MODE", raising=False)
    r = client.post("/api/tashkeel", json={"text": "ذهب الولد إلى المدرسة", "mode": "fast"})
    assert r.status_code == 200
    assert r.json()["engine"] in ("mishkal", "libtashkeel")
    assert strip_marks(r.json()["text"]) == "ذهب الولد إلى المدرسة"
    assert r.json()["text"] != "ذهب الولد إلى المدرسة"


def test_health_engine_mode_logic(client, monkeypatch, tmp_path):
    assert client.get("/health").json()["engine_mode"] == "mock"
    monkeypatch.delenv("MIZAJ_ENGINE_MODE", raising=False)
    monkeypatch.setattr(config, "CATT_DIR", tmp_path / "missing")
    assert client.get("/health").json()["engine_mode"] == "mock"
    d = tmp_path / "present"
    d.mkdir()
    (d / "encoder.onnx").write_bytes(b"x")
    monkeypatch.setattr(config, "CATT_DIR", d)
    assert client.get("/health").json()["engine_mode"] == "real"


# ---------- morph filter (fake analyzer) ----------
class FakeAnalyzer:
    def __init__(self, table):
        self.table = table

    def candidates(self, word):
        return tuple((v, "اسم", 1) for v in self.table.get(word, ()))


def test_morph_filter_rule():
    bare = "مدرسة"
    good = "مَدْرَسَةٌ"
    mf = MorphFilter(FakeAnalyzer({bare: ["مَدْرَسَةٌ", "مَدْرَسَةً", "مَدْرَسَةٍ"]}))
    # conflicting internal vowel -> corrected, CATT's case ending kept
    assert mf.refine_word(bare, "مُدْرَسَةِ") == "مَدْرَسَةِ"
    # already a candidate -> untouched
    assert mf.refine_word(bare, good) == good
    # CATT adds marks mishkal lacks -> untouched (never removes or adds diacritics)
    mf2 = MorphFilter(FakeAnalyzer({"كتاب": ["كِتَابٌ"]}))
    assert mf2.refine_word("كتاب", "كِتَابٍ") == "كِتَابٍ"
    # ambiguous internal patterns -> not confident -> untouched
    mf3 = MorphFilter(FakeAnalyzer({"علم": ["عِلْمٌ", "عَلَمٌ"]}))
    assert mf3.refine_word("علم", "عُلْمٌ") == "عُلْمٌ"
    # unknown word / short word untouched
    assert mf3.refine_word("زززز", "زَزَزَزُ") == "زَزَزَزُ"
    assert mf.refine_word("في", "فَي") == "فَي"


def test_user_fathatan_on_alef_is_not_doubled():
    from app.engine.pipeline import _DOUBLE_FATHATAN

    # engine «قًا» + the user's locked «اً» must not read «وَفْقًاً»
    assert _DOUBLE_FATHATAN.sub(r"\1\2", "وَفْقًاً نِهَائِيًّاً") == "وَفْقاً نِهَائِيّاً"
    assert _DOUBLE_FATHATAN.sub(r"\1\2", "وَفْقًا") == "وَفْقًا"
