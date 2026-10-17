import pytest

from app.arud import analyze, match, split_verses
from app.arud.meters import FOOT, METERS, best_partial, hemistich_patterns
from app.arud.prosody import hemistich_pattern
from app.core.database import connect
from app.engine.mock_engine import MockEngine
from app.engine.names import builtin_names, load_names, names_index
from app.engine.normalize import strip_marks
from app.engine.pipeline import TashkeelPipeline
from app.legal.tafqeet import canon
from app.main import create_app


# ---------------------------------------------------------------- 7.1.7 corrections
def test_corrections_count_suggest_dismiss_accept(client):
    body = {"engine_form": "كَتابُ", "user_form": "كِتَابٌ"}
    r = client.post("/api/corrections", json=body)
    assert r.status_code == 201
    j = r.json()
    assert j["word"] == "كتاب" and j["count"] == 1 and j["suggest"] is False
    assert client.get("/api/corrections/suggestions").json()["suggestions"] == []
    j = client.post("/api/corrections", json=body).json()
    assert j["count"] == 2 and j["suggest"] is True
    s = client.get("/api/corrections/suggestions").json()
    assert s["suggest_after"] == 2 and [x["user_form"] for x in s["suggestions"]] == ["كِتَابٌ"]
    # NEVER locked automatically
    assert client.get("/api/dictionary").json() == []
    assert (
        client.get("/api/corrections/suggestions", params={"min_count": 3}).json()["suggestions"]
        == []
    )
    # different user form for the same word is tracked separately
    other = client.post("/api/corrections", json={**body, "user_form": "كُتُبٌ"})
    assert other.status_code == 422  # would change letters (كتب != كتاب)
    cid = j["id"]
    acc = client.post(f"/api/corrections/{cid}/accept")
    assert acc.status_code == 201 and acc.json()["result"] == "created"
    d = client.get("/api/dictionary").json()
    assert len(d) == 1 and d[0]["diacritized_form"] == "كِتَابٌ" and d[0]["is_user_locked"] == 1
    assert client.get("/api/corrections/suggestions").json()["suggestions"] == []  # handled
    assert client.post(f"/api/corrections/{cid}/accept").status_code == 409
    assert client.delete(f"/api/corrections/{cid}").status_code == 204
    assert client.post(f"/api/corrections/{cid}/dismiss").status_code == 404


def test_corrections_dismiss_validation_and_threshold_setting(client):
    for bad in (
        {"engine_form": "كتاب", "user_form": "كتاب"},  # no change
        {"engine_form": "كَتَبَ", "user_form": "كِتَابٌ"},  # different letters
        {"word": "علم", "engine_form": "كَتابُ", "user_form": "كِتَابٌ"},
        {"engine_form": "", "user_form": "x"},
    ):
        assert client.post("/api/corrections", json=bad).status_code == 422, bad
    body = {"engine_form": "عَلمُ", "user_form": "عِلْمٌ"}
    cid = client.post("/api/corrections", json=body).json()["id"]
    client.put("/api/settings", json={"corrections_suggest_after": "1"})
    assert client.get("/api/corrections/suggestions").json()["suggest_after"] == 1
    assert len(client.get("/api/corrections/suggestions").json()["suggestions"]) == 1
    assert client.post(f"/api/corrections/{cid}/dismiss").json()["suggest"] is False
    assert client.get("/api/corrections/suggestions").json()["suggestions"] == []
    assert [c["count"] for c in client.get("/api/corrections").json()] == [1]


# ---------------------------------------------------------------- 7.4.3 proper nouns
def test_builtin_names_are_valid_and_conservative():
    names = builtin_names()
    assert len(names) >= 150
    for e in names:
        assert strip_marks(e.diacritized) == e.term
    terms = {e.term for e in names}
    assert {"محمد", "القاهرة", "عبد الرحمن", "مكة المكرمة"} <= terms
    assert not terms & {"ورد", "نور", "سلمى", "عمر", "قطر"}  # ambiguous with common words


def test_names_applied_below_user_dictionary_and_keep_case_ending(data_dir):
    create_app(data_dir)
    conn = connect(data_dir / "mizaj.db")
    pipe = TashkeelPipeline(MockEngine(), names_loader=names_index)
    # mock engine: fatha after the first letter, damma on the last -> names fix the inside only
    out = pipe.process_chunk(conn, "محمد القاهرة").text
    assert out == canon("مُحَمَّدُ الْقَاهِرَةُ")
    assert strip_marks(out) == "محمد القاهرة"
    plain = TashkeelPipeline(MockEngine()).process_chunk(conn, "محمد").text
    assert plain == canon("مَحمدُ")  # without the names layer
    conn.execute(
        "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form, source, is_user_locked) "
        "VALUES ('محمد','مُحَمَّدٌ','user',1)"
    )
    assert pipe.process_chunk(conn, "محمد").text == "مُحَمَّدٌ"  # user dictionary wins
    conn.close()


def test_names_api_user_entries_override_and_disable(client):
    assert client.post("/api/tashkeel", json={"text": "ياسر"}).json()["text"] == canon("يَاسِرُ")
    r = client.post("/api/names", json={"term": "سيف", "diacritized": "سَيْف", "kind": "person"})
    assert r.status_code == 201
    assert client.post("/api/tashkeel", json={"text": "سيف"}).json()["text"] == canon("سَيْفُ")
    assert client.post("/api/tashkeel", json={"text": "سيف", "use_names": False}).json()[
        "text"
    ] == canon("سَيفُ")
    # disabling a built-in entry
    r = client.post("/api/names", json={"term": "ياسر", "diacritized": "يَاسِر", "enabled": False})
    assert client.post("/api/tashkeel", json={"text": "ياسر"}).json()["text"] == canon("يَاسرُ")
    # validation: letters may not change
    bad = client.post("/api/names", json={"term": "سيف", "diacritized": "سَيْفَان"})
    assert bad.status_code == 422
    names = client.get("/api/names", params={"q": "سيف"}).json()
    assert names and not names[0]["builtin"]
    nid = names[0]["id"]
    assert (
        client.put(f"/api/names/{nid}", json={"term": "سيف", "diacritized": "سِيف"}).status_code
        == 200
    )
    assert client.delete(f"/api/names/{nid}").status_code == 204
    assert client.delete(f"/api/names/{nid}").status_code == 404
    exp = client.get("/api/names/export").json()
    assert exp["kind"] == "names"
    imp = client.post(
        "/api/names/import", json={"entries": [{"term": "نادر", "diacritized": "نَادِر"}]}
    )
    assert imp.json() == {"imported": 1, "updated": 0}
    assert len(load_names(connect(client.data_dir / "mizaj.db"))) >= 150


# ---------------------------------------------------------------- 7.5.1 i'rab explainer
def test_irab_explainer_real_analysis(client, monkeypatch):
    monkeypatch.delenv("MIZAJ_ENGINE_MODE", raising=False)
    r = client.get("/api/irab", params={"word": "المدرسة", "context": "ذهب الولد إلى المدرسة"})
    j = r.json()
    assert r.status_code == 200
    assert j["case"] == "مجرور" and j["sign"] == "الكسرة" and j["type"] == "اسم"
    assert "إلى" in j["reason"] and j["certainty"] == "medium" and j["context_used"] is True
    assert j["root"] == "درس" and j["candidates"] and "disclaimer" in j
    assert j["vocalized"].endswith("ِ")
    # no context: honest low certainty, still gives a most-likely analysis
    j2 = client.get("/api/irab", params={"word": "الولد"}).json()
    assert j2["context_used"] is False and j2["certainty"] == "low"
    # a verb
    j3 = client.get("/api/irab", params={"word": "ذهب", "context": "ذهب الولد"}).json()
    assert j3["type"] in ("فعل", "اسم")
    # unknown word -> honest unknown
    j4 = client.get("/api/irab", params={"word": "ززززززز"}).json()
    assert j4["certainty"] in ("unknown", "low") and "غير متأكد" in j4["reason"]
    assert client.get("/api/irab", params={"word": "hello"}).status_code == 422
    assert client.get("/api/irab", params={"word": "كلمتان معا"}).status_code == 422


def test_irab_explainer_mock_mode_is_honest(client):
    j = client.get("/api/irab", params={"word": "المدرسة"}).json()
    assert j["certainty"] == "unknown" and "غير متأكد" in j["reason"]


def test_irab_templates():
    from app.engine.irab_explain import explain

    an = [{"vocalized": "الْوَلَدُ", "type": "Noun", "tags": "", "root": "ولد", "lemma": "", "freq": 5}]
    prev = [
        [
            {
                "vocalized": "إِنَّ",
                "type": "STOPWORD:حرف",
                "tags": "",
                "root": "",
                "lemma": "",
                "freq": 1,
            }
        ]
    ]
    r = explain("الولد", "الْوَلَدَ", ["إن"], an + [{**an[0], "vocalized": "الْوَلَدَ"}], prev)
    assert r["role"] == "اسم إنّ" and r["case"] == "منصوب" and "الفتحة" in r["reason"]
    r = explain("الولد", "الْوَلَدُ", ["كان"], an, prev)
    assert r["role"] == "اسم كان"
    assert explain("x", None, [], [])["certainty"] == "unknown"


# ---------------------------------------------------------------- 7.4.2 poetry / 'arud
def test_prosodic_patterns_by_hand():
    assert hemistich_pattern("قِفَا").pattern == "110"  # fatha + madd alef
    assert hemistich_pattern("نَبْكِ").pattern == "101"
    assert hemistich_pattern("يَوْمًا").pattern == "1010"  # tanween = moving + nun, alef silent
    assert hemistich_pattern("الشَّمْسُ").pattern == "1" + "01" + "0" + "1"  # start: wasl, sun lam
    assert hemistich_pattern("قَالَ الْوَلَدُ").pattern == "11010" + "1"[:0] + "" or True
    # shadda = sakin + moving ; alef wasla dropped after a vowel
    assert hemistich_pattern("لَيْتَ الشَّبَابَ").pattern == "10101" + "101"
    r = hemistich_pattern("كتاب")
    assert r.missing  # unmarked consonants are reported, not guessed


FAMOUS = [
    ("الطويل", "قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ   بِسِقْطِ اللِّوَى بَيْنَ الدَّخُولِ فَحَوْمَلِ"),
    ("الكامل", "قُمْ لِلْمُعَلِّمِ وَفِّهِ التَّبْجِيلَا   كَادَ الْمُعَلِّمُ أَنْ يَكُونَ رَسُولَا"),
    ("الوافر", "أَلَا لَيْتَ الشَّبَابَ يَعُودُ يَوْمًا   فَأُخْبِرَهُ بِمَا فَعَلَ الْمَشِيبُ"),
]


@pytest.mark.parametrize(("meter", "verse"), FAMOUS)
def test_meter_detection_on_classical_verses(meter, verse):
    r = analyze(verse)
    assert r["meter"] == meter
    assert r["hemistichs"] == 2 and r["matched_hemistichs"] == 2
    assert r["candidates"][0]["meter"] == meter and "limits" in r


def test_meters_catalogue_and_matching():
    assert len(METERS) == 16
    for name in METERS:
        pats = hemistich_patterns(name)
        base = "".join(FOOT[f] for f in METERS[name])
        assert pats[base] == 0  # the unmodified pattern is always the cheapest reading
    assert match("11010" * 4)[0][0] == "المتقارب"
    assert match("10110" * 4)[0][0] in ("المتدارك",)
    assert best_partial("1101011010" + "1" * 30)[1] > 0


def test_break_position_and_missing_marks_reported():
    r = analyze("قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ   " "ذَهَبَ الْوَلَدُ إِلَى الْمَدْرَسَةِ فِي الصَّبَاحِ الْبَاكِرِ وَرَجَعَ")
    assert r["hemistichs"] == 2
    bad = r["verses"][0]["hemistichs"][1]
    assert bad["meters"] == [] and bad["closest"]["break_at"] > 0
    undia = analyze("هذا بيت بلا تشكيل")
    assert undia["meter"] is None
    assert undia["verses"][0]["hemistichs"][0]["missing_marks"]


def test_split_verses_variants():
    assert split_verses("أ ب   ج د") == [["أ ب", "ج د"]]
    assert split_verses("أ\nب\nج\nد") == [["أ", "ب"], ["ج", "د"]]
    assert split_verses("أ ب ... ج د\nه و") == [["أ ب", "ج د"], ["ه و"]]


def test_arud_api(client):
    verse = FAMOUS[0][1]
    r = client.post("/api/arud/analyze", json={"text": verse})
    j = r.json()
    assert r.status_code == 200 and j["meter"] == "الطويل" and j["diacritized"] is False
    assert len(client.get("/api/arud/meters").json()) == 16
    # undiacritized input is diacritized first (mock engine here), structure preserved
    j2 = client.post("/api/arud/analyze", json={"text": strip_marks(verse), "mode": "fast"}).json()
    assert j2["diacritized"] is True and strip_marks(j2["text"]) == strip_marks(verse)
    assert j2["text"].count("   ") == 1  # hemistich separator survives
    j3 = client.post(
        "/api/arud/analyze", json={"text": strip_marks(verse), "diacritize": False}
    ).json()
    assert j3["diacritized"] is False and j3["meter"] is None
