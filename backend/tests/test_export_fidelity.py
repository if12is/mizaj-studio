"""Export fidelity: an exported Word file keeps everything of the original and only carries the
text changes made in the app. Runs every committed fixture through import -> edit -> export
(`as_is`) and diffs every part of the zip against the source."""

import re
import zipfile
from pathlib import Path

import pytest
from lxml import etree

from app.docx.mixed import is_code_run

FX = Path(__file__).parent / "fixtures" / "fidelity"
FIXTURES = sorted(FX.glob("*.docx"))
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WT, WP, WR = f"{{{W}}}t", f"{{{W}}}p", f"{{{W}}}r"
XS = "{http://www.w3.org/XML/1998/namespace}space"
FIXES = [
    ("المحاماه", "المحاماة"), ("الاسكندريه", "الإسكندرية"), ("اقام", "أقام"), ("الدعوي", "الدعوى"),
    ("مذكره", "مذكرة"), ("لسنه", "لسنة"),
    ("صحيفه", "صحيفة"), ("الزام", "إلزام"), ("اداره", "إدارة"),
    ("الدائره", "الدائرة"), ("مأموريه", "مأمورية"), ("محكمه", "محكمة"), ("اولا", "أولاً"),
    ("ثانيا", "ثانياً"),
    ("الماده", "المادة"), ("ملاحظه", "ملاحظة"), ("هامه", "هامة"),
    ("القضيه", "القضية"), ("عداله", "عدالة"), (" .", "."), (" ،", "،"),
]  # fmt: skip
FATHA = "َ"


def tashkeel(text: str) -> str:
    return re.sub("([ء-ي])(?![ً-ْ])", lambda m: m.group(1) + FATHA, text)


def parts(path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i) for i in z.infolist()}


def norm(xml: bytes):
    root = etree.fromstring(xml)
    for t in root.iter(WT):
        t.text = ""
        t.attrib.pop(XS, None)
    return root


def first_diff(a, b, path="") -> str | None:
    here = f"{path}/{etree.QName(a).localname}"
    if a.tag != b.tag:
        return f"tag {here}: {a.tag} != {b.tag}"
    if dict(a.attrib) != dict(b.attrib):
        return f"attr {here}: {dict(a.attrib)} != {dict(b.attrib)}"
    if a.tag != WT and (a.text or "").strip() != (b.text or "").strip():
        return f"text {here}"
    ca, cb = list(a), list(b)
    if len(ca) != len(cb):
        return f"children {here}: {[etree.QName(x).localname for x in ca]} != " \
               f"{[etree.QName(x).localname for x in cb]}"
    for i, (x, y) in enumerate(zip(ca, cb, strict=True)):
        d = first_diff(x, y, f"{here}[{i}]")
        if d:
            return d
    return None


def flow_lines(xml: bytes) -> list[tuple[str, bool]]:
    """Flow lines like the importer: one entry per body paragraph (w:br lines split further),
    tab -> \\t, br -> \\n, text boxes excluded. The flag marks lines of paragraphs with a code-font
    run: the app never rewrites those (known design limit), so they must stay as in the source."""
    root = etree.fromstring(xml)
    out: list[tuple[str, bool]] = []
    for p in root.iter(WP):
        if any(etree.QName(a).localname == "txbxContent" for a in p.iterancestors()):
            continue
        s, code = [], False
        for r in p.iter(WR):
            if next(a for a in r.iterancestors() if a.tag == WP) is not p:
                continue
            code |= is_code_run(r)
            for c in r:
                n = etree.QName(c).localname
                if n == "t":
                    s.append(c.text or "")
                elif n == "tab":
                    s.append("\t")
                elif n in ("br", "cr"):
                    s.append("\n")
        out.extend((line, code) for line in "".join(s).split("\n"))
    return out


def assert_same_but_text(src, out, text):
    a, b = parts(src), parts(out)
    assert set(a) == set(b)
    for name, data in a.items():
        if name == "word/document.xml":
            continue
        assert data == b[name], f"{name} changed"
    d = first_diff(norm(a["word/document.xml"]), norm(b["word/document.xml"]))
    assert d is None, d
    # the editor holds no line for paragraphs without text: compare the non-blank lines
    before = [x for x in flow_lines(a["word/document.xml"]) if x[0].strip()]
    after = [x for x in flow_lines(b["word/document.xml"]) if x[0].strip()]
    want = [x for x in text.split("\n") if x.strip()]
    assert len(want) == len(after) == len(before)
    for i, ((old, code), (got, _), w) in enumerate(zip(before, after, want, strict=True)):
        assert got == (old if code else w), f"line {i}: {got!r} != {(old if code else w)!r}"


def do_import(client, src, pid=None):
    pid = pid or client.post("/api/projects", json={"name": "P"}).json()["id"]
    r = client.post("/api/docx/import", json={"path": str(src), "project_id": pid})
    assert r.status_code == 201, r.text
    did = r.json()["document_id"]
    return did, client.get(f"/api/documents/{did}").json()["raw_content"]


def export(client, did, out, **kw):
    return client.post(
        "/api/docx/export",
        json={"document_id": did, "target_path": str(out), "as_is": True, **kw},
    )


def scenarios(raw):
    fixed = raw
    for a, b in FIXES:
        fixed = fixed.replace(a, b)
    diac = tashkeel(fixed)
    return {
        "S0": ({}, raw),
        "S1": ({"raw_content": fixed}, fixed),
        "S2": ({"raw_content": diac, "diacritized_content": diac}, diac),
    }


def test_fixtures_present():
    assert len(FIXTURES) >= 5


@pytest.mark.parametrize("src", FIXTURES, ids=lambda p: p.stem)
def test_as_is_export_keeps_everything_but_text(client, tmp_path, src):
    did, raw = do_import(client, src)
    for name, (put, text) in scenarios(raw).items():
        if put:
            assert client.put(f"/api/documents/{did}", json=put).status_code == 200
        out = tmp_path / f"{src.stem}-{name}.docx"
        r = export(client, did, out)
        assert r.status_code == 200, r.text
        assert_same_but_text(src, out, text)


def test_untouched_as_is_export_keeps_header_footer_bytes(client, tmp_path):
    src = FX / "legal_memo.docx"
    did, _ = do_import(client, src)
    out = tmp_path / "o.docx"
    assert export(client, did, out).status_code == 200
    a, b = parts(src), parts(out)
    nonbody = [n for n in a if re.match(r"word/(header|footer|footnotes|endnotes)", n)]
    assert nonbody
    for n in nonbody:
        assert a[n] == b[n], n


def test_snapshot_fallback_when_original_is_gone(client, tmp_path):
    src = tmp_path / "memo.docx"
    src.write_bytes((FX / "legal_memo.docx").read_bytes())
    did, raw = do_import(client, src)
    assert (client.data_dir / "sources" / f"doc-{did}.docx").is_file()
    src.rename(tmp_path / "moved.docx")
    out = tmp_path / "o.docx"
    r = export(client, did, out)
    assert r.status_code == 200, r.text
    assert_same_but_text(FX / "legal_memo.docx", out, raw)
    # the page view falls back the same way
    assert client.post("/api/docx/render", json={"document_id": did}).status_code == 200


def test_source_missing_error_when_original_and_snapshot_gone(client, tmp_path):
    src = tmp_path / "memo.docx"
    src.write_bytes((FX / "legal_memo.docx").read_bytes())
    did, _ = do_import(client, src)
    src.unlink()
    (client.data_dir / "sources" / f"doc-{did}.docx").unlink()
    out = tmp_path / "o.docx"
    for url, body in (
        ("/api/docx/export", {"document_id": did, "target_path": str(out), "as_is": True}),
        ("/api/docx/export-tracked", {"document_id": did, "target_path": str(out)}),
        ("/api/docx/render", {"document_id": did}),
    ):
        r = client.post(url, json=body)
        assert r.status_code == 409, (url, r.text)
        assert r.json()["error_code"] == "ERR_DOCX_SOURCE_MISSING"
        assert r.json()["details"]["path"] == str(src)
    assert not out.exists()


def test_document_without_source_still_generates_new_file(client, tmp_path):
    pid = client.post("/api/projects", json={"name": "P"}).json()["id"]
    did = client.post(
        "/api/documents", json={"project_id": pid, "title": "t", "raw_content": "كتاب"}
    ).json()["id"]
    out = tmp_path / "o.docx"
    assert export(client, did, out).status_code == 200 and out.exists()
