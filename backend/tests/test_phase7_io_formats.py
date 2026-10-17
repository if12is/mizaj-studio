# ruff: noqa: F811, E501
import codecs
import time
import zipfile

from docx_factory import build_rich_docx, build_tab_marks_docx
from io_helpers import ioc  # noqa: F401
from lxml import etree

from app.engine.normalize import strip_marks
from app.io import formats

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
Q = lambda t: f"{{{W}}}{t}"  # noqa: E731
TEXT = "ذهب الولد إلى المدرسة\nقرأ الطالب الكتاب"


# ------------------------------------------------------------------ encodings / text formats
def test_decode_detection():
    s = "كتاب جميل"
    assert formats.decode_bytes(codecs.BOM_UTF8 + s.encode()) == (s, "utf-8-sig")
    assert formats.decode_bytes(s.encode("utf-16")) == (s, "utf-16")
    assert formats.decode_bytes(s.encode("utf-16-le")) == (s, "utf-16-le")
    assert formats.decode_bytes(s.encode("utf-16-be")) == (s, "utf-16-be")
    assert formats.decode_bytes(s.encode("utf-8")) == (s, "utf-8")
    assert formats.decode_bytes(s.encode("cp1256")) == (s, "cp1256")


def fake(t: str) -> str:  # deterministic stand-in: fatha on every first letter
    return " ".join(w[0] + "َ" + w[1:] if w and "؀" <= w[0] <= "ۿ" else w for w in t.split(" "))


def test_markdown_keeps_syntax():
    md = (
        "---\ntitle: كتاب\n---\n# عنوان كبير\n\n- نقطة أولى [رابط](http://x.y/كتاب)\n"
        "1. قائمة `code كتاب` نهاية\n> اقتباس هنا\n\n```py\nكتاب = 1\n```\n"
    )
    out = formats.diacritize_markdown(md, fake)
    lines = out.split("\n")
    assert lines[1] == "title: كتاب"  # front matter untouched
    assert lines[3].startswith("# ") and "عَنوان" in lines[3]
    assert "(http://x.y/كتاب)" in out and "`code كتاب`" in out
    assert "كتاب = 1" in out  # fenced block untouched
    assert lines[-4] == "```py" or "```py" in lines
    assert strip_marks(out) == md


def test_srt_keeps_timing():
    srt = "1\n00:00:01,000 --> 00:00:02,500\nمرحبا بكم\n<i>أهلا وسهلا</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nشكرا\n"
    out = formats.diacritize_srt(srt, fake)
    assert "00:00:01,000 --> 00:00:02,500" in out and "<i>" in out and "</i>" in out
    assert out.split("\n")[0] == "1" and "مَرحبا" in out
    assert strip_marks(out) == srt


def test_convert_txt_cp1256_to_utf8_and_batch_never_overwrites(ioc, tmp_path):
    src = tmp_path / "in"
    (src / "sub").mkdir(parents=True)
    (src / "a.txt").write_bytes("ذهب الولد\r\nإلى المدرسة".encode("cp1256"))
    (src / "sub" / "b.md").write_text("# عنوان\nنص عربي", encoding="utf-8")
    (src / "sub" / "c.srt").write_text(
        "1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n", encoding="utf-8"
    )
    (src / "bad.docx").write_bytes(b"not a docx")
    (src / "skip.xyz").write_text("x")
    out = tmp_path / "out"
    before = {p: p.read_bytes() for p in src.rglob("*") if p.is_file()}
    r = ioc.post(
        "/api/batch",
        json={
            "input_dir": str(src),
            "output_dir": str(out),
            "formats": ["txt", "md", "srt", "docx"],
        },
    )
    assert r.status_code == 202, r.text
    jid = r.json()["job_id"]
    for _ in range(100):
        st = ioc.get(f"/api/batch/{jid}").json()
        if st["status"] in ("done", "failed", "cancelled"):
            break
        time.sleep(0.1)
    assert st["status"] == "done" and st["total"] == 4 and st["succeeded"] == 3
    assert len(st["errors"]) == 1 and st["errors"][0]["error_code"] == "ERR_DOCX_CORRUPT"
    a = (out / "a.txt").read_bytes().decode("utf-8")
    assert "\r\n" in a and strip_marks(a) == "ذهب الولد\r\nإلى المدرسة"
    assert (out / "sub" / "b.md").read_text(encoding="utf-8").startswith("# ")
    assert {p: p.read_bytes() for p in src.rglob("*") if p.is_file()} == before
    # same output dir again: existing outputs renamed, never clobbered
    r = ioc.post(
        "/api/batch", json={"input_dir": str(src), "output_dir": str(out), "formats": ["txt"]}
    )
    jid = r.json()["job_id"]
    for _ in range(100):
        if ioc.get(f"/api/batch/{jid}").json()["status"] == "done":
            break
        time.sleep(0.1)
    assert (out / "a_1.txt").exists()
    # output == input is refused
    bad = ioc.post(
        "/api/batch", json={"input_dir": str(src), "output_dir": str(src), "formats": ["txt"]}
    )
    assert bad.status_code == 422


def test_batch_cancel(ioc, tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    for i in range(30):
        (src / f"{i}.txt").write_text("ذهب الولد إلى المدرسة " * 50, encoding="utf-8")
    jid = ioc.post(
        "/api/batch",
        json={"input_dir": str(src), "output_dir": str(tmp_path / "o"), "formats": ["txt"]},
    ).json()["job_id"]
    ioc.post(f"/api/batch/{jid}/cancel")
    for _ in range(100):
        st = ioc.get(f"/api/batch/{jid}").json()
        if st["status"] != "running" and st["status"] != "queued":
            break
        time.sleep(0.1)
    assert st["status"] in ("cancelled", "done")
    assert ioc.get("/api/batch/nope").status_code == 404


# ------------------------------------------------------------------ EPUB
def make_epub(path):
    xhtml = (
        '<?xml version="1.0" encoding="utf-8"?>\n<html xmlns="http://www.w3.org/1999/xhtml"><head>'
        "<title>كتاب</title><style>p{}</style></head><body><h1>عنوان الكتاب</h1>"
        '<p>ذهب <b>الولد</b> إلى <a href="كتاب.xhtml">المدرسة</a> اليوم</p>'
        "<pre>كود كتاب</pre><script>var x='كتاب';</script></body></html>"
    )
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr("META-INF/container.xml", "<container/>")
        z.writestr("OEBPS/ch1.xhtml", xhtml)
        z.writestr("OEBPS/cover.png", b"\x89PNG")
    return path


def test_epub_text_nodes_only(tmp_path):
    src, dst = make_epub(tmp_path / "a.epub"), tmp_path / "b.epub"
    stats = formats.diacritize_epub(src, dst, fake)
    assert stats["documents"] == 1 and stats["blocks_changed"] >= 2
    with zipfile.ZipFile(dst) as z:
        assert (
            z.namelist()[0] == "mimetype"
            and z.getinfo("mimetype").compress_type == zipfile.ZIP_STORED
        )
        assert z.read("OEBPS/cover.png") == b"\x89PNG"
        x = z.read("OEBPS/ch1.xhtml").decode()
    assert "كود كتاب" in x and "var x='كتاب'" in x and 'href="كتاب.xhtml"' in x  # untouched
    assert "عَنوان" in x and "<b>" in x and "اَلولد" in x
    assert (
        strip_marks(x).split("?>", 1)[1]
        == zipfile.ZipFile(src).read("OEBPS/ch1.xhtml").decode().split("?>", 1)[1]
    )
    assert "الولد" in formats.epub_text(src)


def test_epub_corrupt(tmp_path):
    p = tmp_path / "x.epub"
    p.write_bytes(b"junk")
    try:
        formats.diacritize_epub(p, tmp_path / "y.epub", fake)
    except Exception as e:  # noqa: BLE001
        assert e.error_code == "ERR_FILE_INVALID"
    else:
        raise AssertionError


# ------------------------------------------------------------------ PDF
def test_pdf_export_import_roundtrip(ioc, tmp_path):
    pdf = tmp_path / "o.pdf"
    r = ioc.post(
        "/api/io/export",
        json={"target_path": str(pdf), "text": "ذَهَبَ الوَلَدُ إلى المدرسة\nسطر ثان", "title": "t"},
    )
    assert r.status_code == 200, r.text
    assert pdf.read_bytes().startswith(b"%PDF")
    imp = ioc.post("/api/io/import", json={"path": str(pdf)}).json()
    assert imp["format"] == "pdf" and imp["text"].strip()


def test_import_txt_and_formats_list(ioc, tmp_path):
    p = tmp_path / "t.txt"
    p.write_bytes("مرحبا".encode("utf-16"))
    j = ioc.post("/api/io/import", json={"path": str(p)}).json()
    assert j["text"] == "مرحبا" and j["encoding"] == "utf-16"
    assert "epub" in ioc.get("/api/io/formats").json()["import"]
    assert ioc.post("/api/io/import", json={"path": str(tmp_path / "x.exe")}).status_code in (
        404,
        422,
    )


# ------------------------------------------------------------------ track changes
def revisions(path):
    out = {}
    with zipfile.ZipFile(path) as z:
        for n in z.namelist():
            if n.endswith(".xml") and n.startswith("word/"):
                out[n] = z.read(n)
    return out


def resolve(xml: bytes, accept: bool) -> etree._Element:
    root = etree.fromstring(xml)
    drop, keep = (Q("del"), Q("ins")) if accept else (Q("ins"), Q("del"))
    for el in list(root.iter(drop)):
        el.getparent().remove(el)
    for el in list(root.iter(keep)):
        parent, idx = el.getparent(), el.getparent().index(el)
        for k, child in enumerate(list(el)):
            parent.insert(idx + k, child)
        parent.remove(el)
    for dt in root.iter(Q("delText")):
        dt.tag = Q("t")
    return root


def para_texts(root) -> list[str]:
    return ["".join(t.text or "" for t in p.iter(Q("t"))) for p in root.iter(Q("p"))]


def test_track_changes_accept_equals_normal_reject_equals_original(ioc, tmp_path):
    for builder in (build_rich_docx, build_tab_marks_docx):
        src = builder(tmp_path / f"{builder.__name__}.docx")
        plain, tracked = tmp_path / "plain.docx", tmp_path / "tracked.docx"
        r = ioc.post("/api/io/convert", json={"input_path": str(src), "output_path": str(plain)})
        assert r.status_code == 200, r.text
        r = ioc.post(
            "/api/io/docx/track-changes",
            json={"source_path": str(src), "target_path": str(tracked)},
        )
        assert r.status_code == 200, r.text
        assert r.json()["stats"]["revisions"] > 0 and r.json()["stats"]["author"] == "مِزَاج"
        orig, pl, tr = revisions(src), revisions(plain), revisions(tracked)
        for name, xml in tr.items():
            if name not in orig:
                continue
            if b"<w:ins" not in xml and b"<w:del" not in xml:
                continue
            acc, want = para_texts(resolve(xml, True)), para_texts(etree.fromstring(pl[name]))
            if builder is build_rich_docx:
                assert acc == want, name
            else:  # marks typed after a tab: placement is a documented edge case
                assert [strip_marks(a) for a in acc] == [strip_marks(w) for w in want]
            assert para_texts(resolve(xml, False)) == para_texts(etree.fromstring(orig[name])), name
        body = tr["word/document.xml"]
        root = etree.fromstring(body)
        ids = [e.get(Q("id")) for e in root.iter(Q("ins"), Q("del"))]
        assert len(ids) == len(set(ids)) and all(
            e.get(Q("author")) == "مِزَاج" and e.get(Q("date")) for e in root.iter(Q("ins"), Q("del"))
        )
        # per-word granularity: every w:del holds a single word
        for d in root.iter(Q("del")):
            assert len("".join(t.text for t in d.iter(Q("delText"))).split()) <= 1
        from docx import Document

        Document(str(tracked))  # still opens
