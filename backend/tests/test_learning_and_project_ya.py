"""Learning from corrections (dictionary wins later) and the per-project ya_style override."""

from __future__ import annotations

from app.engine.normalize import strip_marks

TEXT = "في الدعوى مدني والذي"


def test_user_dictionary_entry_wins_in_later_runs_even_from_the_chunk_cache(client):
    first = client.post("/api/tashkeel", json={"text": "كتاب جديد"}).json()["text"]
    # the engine output is now cached; a user correction must still win afterwards
    form = "كِتَابٌ"
    assert first != form + " جديد"
    r = client.post("/api/dictionary", json={"word_or_phrase": "كتاب", "diacritized_form": form})
    assert r.status_code == 201
    for _ in range(2):  # cold and cached chunk
        out = client.post("/api/tashkeel", json={"text": "كتاب جديد"}).json()["text"]
        assert out.split(" ")[0] == form
        assert strip_marks(out) == "كتاب جديد"
    # a different level and an already marked input are covered too
    out = client.post("/api/tashkeel", json={"text": "كتاب", "level": "minimal"}).json()["text"]
    assert out == form


def test_dictionary_rejects_a_form_with_different_base_letters(client):
    r = client.post("/api/dictionary", json={"word_or_phrase": "كتاب", "diacritized_form": "كِتَابَا"})
    assert r.status_code == 422


def test_project_ya_style_defaults_to_null_and_round_trips(client):
    p = client.post("/api/projects", json={"name": "قضية"}).json()
    assert p["ya_style"] is None
    r = client.put(f"/api/projects/{p['id']}", json={"ya_style": "egyptian"})
    assert r.json()["ya_style"] == "egyptian"
    # other updates keep the override
    r = client.put(f"/api/projects/{p['id']}", json={"name": "قضية ٢"})
    assert r.json()["ya_style"] == "egyptian"
    assert client.get(f"/api/projects/{p['id']}").json()["ya_style"] == "egyptian"
    # explicit null returns to the global setting
    r = client.put(f"/api/projects/{p['id']}", json={"ya_style": None})
    assert r.json()["ya_style"] is None
    assert client.put(f"/api/projects/{p['id']}", json={"ya_style": "bad"}).status_code == 422


def test_proofread_uses_project_style_then_global_setting(client):
    pid = client.post("/api/projects", json={"name": "ع"}).json()["id"]
    other = client.post("/api/projects", json={"name": "ب"}).json()["id"]

    def style(**kw) -> str:
        r = client.post("/api/proofread", json={"text": TEXT, "categories": ["ya"], **kw})
        assert r.status_code == 200
        return r.json()["ya_style"]

    assert style() == "standard"  # no setting at all
    client.put("/api/settings", json={"ya_style": "egyptian"})
    assert style() == "egyptian"
    assert style(project_id=pid) == "egyptian"  # no override: the global value
    client.put(f"/api/projects/{pid}", json={"ya_style": "standard"})
    assert style(project_id=pid) == "standard"  # the project wins over the global setting
    assert style(project_id=other) == "egyptian"  # other projects are unaffected
    assert style(project_id=pid, ya_style="egyptian") == "egyptian"  # an explicit value still wins
    assert style(project_id=99999) == "egyptian"  # unknown project: global
