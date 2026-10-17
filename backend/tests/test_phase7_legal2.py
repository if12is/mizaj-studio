from app.legal import citations as cit
from app.legal import compare as cmp
from app.legal import lint as lnt
from app.legal import redact as rdc


def rules(text, **kw):
    return {i["rule"] for i in lnt.lint(text, **kw)["issues"]}


def test_lint_rules():
    t = (
        "يلتزم المستأجر بالدفع ويجوز للمؤجر الفسخ ولا يجب عليه الإنذار. "
        "يُسدَّد المبلغ 5000 جنيه و/أو ما يعادله في أقرب وقت.\n"
        "المؤجر والمستأجر اتفقا وعليه فإن له الحق. التاريخ 12/05/2024 وفق الملحق رقم 1."
    )
    r = rules(t)
    for want in ("modal_mixed", "modal_negated_must", "passive_no_agent", "amount_figures_only",
                 "and_or", "vague_term", "pronoun_reference", "date_no_calendar",
                 "missing_appendix"):  # fmt: skip
        assert want in r, want


def test_lint_disable_and_clean():
    t = "هذا و/أو ذاك"
    assert "and_or" in rules(t) and "and_or" not in rules(t, disabled=["and_or"])
    assert rules("يلتزم المؤجر بتسليم العين.") == set()
    long = " ".join(["كلمة"] * 70)
    assert "long_sentence" in rules(long)
    ok = "المبلغ 5000 جنيه (خمسة آلاف جنيه)"
    assert "amount_figures_only" not in rules(ok)
    assert "amount_mismatch" in rules("المبلغ 5000 جنيه (أربعة آلاف جنيه)")


def test_structure_checklist():
    s = lnt.check_structure("السيد المدير المحترم\nتحية طيبة وبعد\nالموضوع: كذا", "official_letter")
    assert {m["id"] for m in s["missing"]} >= {"closing"}


def test_citations():
    t = (
        "المادة (5) من القانون رقم 131 لسنة 1948 والمادة الخامسة من القانون رقم (131) لسنة 1948م.\n"
        "المادة ٥ (السادسة). القانون رقم 1948 لسنة 131. "
        "المادة 7 مكرراً (أ) من القانون رقم 5 لسنة 2000.\n"
        "﴿...﴾ [البقرة: 282] [البقرة: 400]"
    )
    idx = cit.validate_index({"kind": "law-index", "laws": [
        {"name": "القانون المدني", "number": "131", "year": 1948, "articles": 4}]})  # fmt: skip
    r = cit.analyze_citations(t, idx)
    kinds = {i["type"] for i in r["issues"]}
    assert {"article_number_mismatch", "implausible_year", "quran_ayah_out_of_range",
            "variant_forms", "law_not_in_index"} <= kinds  # fmt: skip
    assert any(a["bis"] and a["sub"] == "أ" for a in r["articles"])
    assert sum(1 for q in r["quran"] if q["valid_range"]) == 1
    r2 = cit.analyze_citations("المادة 10 من القانون رقم 131 لسنة 1948", idx)
    assert any(i["type"] == "article_exceeds_law" for i in r2["issues"])
    assert sum(n for _, n in cit.SURAHS) == 6236


def test_law_index_validation():
    import pytest

    with pytest.raises(cit.IndexError_):
        cit.validate_index({"kind": "x"})
    with pytest.raises(cit.IndexError_):
        cit.validate_index({"kind": "law-index", "laws": [{"name": "a", "articles": 0}]})


def test_redact_checksums():
    assert rdc.luhn_ok("1000000008") and not rdc.luhn_ok("1000000009")
    assert rdc.eg_id_ok("29001011234567") and not rdc.eg_id_ok("29013411234567")
    assert rdc.iban_ok("SA03 8000 0000 6080 1016 7519") and not rdc.iban_ok(
        "SA04 8000 0000 6080 1016 7519"
    )


def test_redact_text_and_mapping():
    t = (
        "السيد/ أحمد محمد علي، رقم قومي 29001011234567 (ويُشار إليه بـ «المؤجر») جوال 0501234567 "
        "و+201012345678 بريد a@b.com آيبان SA0380000000608010167519. أحمد محمد علي يلتزم."
    )
    r = rdc.redact(t)
    cats = {e["kind"] for e in r["edits"]}
    assert {"eg_national_id", "email", "iban", "party_name"} <= cats
    assert r["applied"] is False
    out = rdc.apply_edits(t, r["edits"])
    assert "29001011234567" not in out and out.count("[المؤجر]") == 2
    assert all(m["original"] and m["replacement"] for m in r["mapping"])
    only = rdc.redact(t, ["email"], "mask")
    assert [e["kind"] for e in only["edits"]] == ["email"]
    pseudo = rdc.redact(t, ["id"], "pseudonym")
    assert all(e["replacement"] != e["original"] for e in pseudo["edits"])


def test_compare_ignores_marks():
    a = "يلتزم المستأجر بدفع 1,500 جنيه شهرياً.\nبند محذوف."
    b = "يَلْتَزِمُ المستأجر بدفع ٢٠٠٠ جنيه شهريا."
    r = cmp.compare_texts(a, b)
    assert r["counts"]["format_only"] == 2 and r["counts"]["replace"] == 1
    assert r["summary"]["by_category"].get("amounts") == 1
    assert not cmp.compare_texts("كتاب", "كِتَابٌ")["hunks"][0]["type"] == "replace"
    assert cmp.compare_texts("أحمد", "احمد")["identical"]


def test_api_endpoints(client):
    r = client.post("/api/legal/lint", json={"text": "في أقرب وقت", "doc_type": "official_letter"})
    assert r.status_code == 200 and r.json()["issues"][0]["rule"] == "vague_term"
    assert "structure" in r.json()
    assert client.post("/api/legal/lint", json={"text": "x", "rules": ["nope"]}).status_code == 422
    assert len(client.get("/api/legal/lint/rules").json()["rules"]) >= 10

    idx = {
        "kind": "law-index",
        "laws": [{"name": "المدني", "number": "131", "year": 1948, "articles": 4}],
    }
    assert client.put("/api/legal/law-index", json=idx).json() == {"count": 1}
    assert client.get("/api/legal/law-index").json()["laws"][0]["number"] == "131"
    c = client.post(
        "/api/legal/citations", json={"text": "المادة 9 من القانون رقم 131 لسنة 1948"}
    ).json()
    assert any(i["type"] == "article_exceeds_law" for i in c["issues"])
    assert client.put("/api/legal/law-index", json={"kind": "bad"}).status_code == 422
    assert client.delete("/api/legal/law-index").status_code == 204

    rd = client.post("/api/legal/redact", json={"text": "a@b.com", "style": "placeholder"}).json()
    assert rd["edits"][0]["replacement"] == "[بريد 1]" and rd["applied"] is False

    cp = client.post("/api/legal/compare", json={"a": "عقد 5", "b": "عقد 6"}).json()
    assert cp["summary"]["by_category"]["numbers"] == 1
    assert client.post("/api/legal/compare", json={"a": "x"}).status_code == 422
    d = client.post("/api/legal/compare", json={"document_a": 999, "document_b": 999})
    assert d.status_code == 404


def test_official_templates_seeded(client):
    lst = client.get("/api/legal/templates").json()
    names = {t["name"] for t in lst}
    for n in ("خطاب رسمي لجهة حكومية", "مذكرة دفاع", "صحيفة دعوى", "إنذار على يد محضر", "توكيل",
              "محضر اجتماع", "طلب رسمي", "شكوى", "مذكرة قانونية داخلية", "عقد عمل محدد المدة",
              "عقد توريد", "عقد مقاولة"):  # fmt: skip
        assert n in names
    t = next(x for x in lst if x["name"] == "خطاب رسمي لجهة حكومية")
    body = client.get(f"/api/legal/templates/{t['id']}").json()["body"]
    assert "يحتاج مراجعة مختص" in body and "تحية طيبة وبعد" in body and "فائق الاحترام" in body
    vals = {"الجهة_المرسلة": "ش", "التاريخ": "2025-03-04", "المرسل_إليه": "و",
            "صفة_المخاطب": "مدير", "الموضوع": "م", "نص_الخطاب": "ن", "اسم_الموقّع": "س",
            "صفة_الموقّع": "ص", "بسملة": "نعم"}  # fmt: skip
    out = client.post(f"/api/legal/templates/{t['id']}/render", json={"values": vals}).json()
    assert out["text"].lstrip().find("بسم الله الرحمن الرحيم") >= 0
