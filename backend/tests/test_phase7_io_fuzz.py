# ruff: noqa: F811, E501
"""7.7.3 seeded mutational fuzzing of the DOCX parser/processors (no hypothesis dependency).

Contract: every mutated file either processes or fails with MizajError ERR_DOCX_CORRUPT
(or ERR_VALIDATION), never with another exception, and never hangs."""

import io
import random
import signal
import zipfile

import pytest
from docx_factory import build_rich_docx, build_tab_marks_docx

from app.core.database import connect
from app.core.errors import MizajError
from app.docx.service import extract_plain_text, process_docx
from app.engine.mock_engine import MockEngine
from app.engine.pipeline import TashkeelPipeline
from app.io.trackchanges import process_docx_tracked

SEED, CASES, TIMEOUT = 20261017, 120, 20
ALLOWED = {"ERR_DOCX_CORRUPT", "ERR_VALIDATION"}


class Timeout(Exception):
    pass


def _alarm(*_):
    raise Timeout


def members(path):
    with zipfile.ZipFile(path) as z:
        return {i.filename: z.read(i) for i in z.infolist()}


def build_zip(m: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for n, b in m.items():
            z.writestr(n, b)
    return buf.getvalue()


def mutate_xml(rng: random.Random, data: bytes) -> bytes:
    kind = rng.randrange(9)
    s = data.decode("utf-8", "replace")
    if kind == 0:  # truncate
        return data[: rng.randrange(len(data) + 1)]
    if kind == 1:  # flip bytes
        b = bytearray(data)
        for _ in range(rng.randrange(1, 8)):
            if b:
                b[rng.randrange(len(b))] = rng.randrange(256)
        return bytes(b)
    if kind == 2:  # drop a random tag
        tags = [i for i in range(len(s)) if s[i] == "<"]
        if tags:
            i = rng.choice(tags)
            j = s.find(">", i)
            return (s[:i] + s[j + 1 :]).encode()
    if kind == 3:  # rename a tag
        return s.replace("<w:t ", "<w:r ", 1).replace("<w:t>", "<w:p>", 1).encode()
    if kind == 4:  # duplicate a paragraph deeply nested
        i, j = s.find("<w:p>"), s.find("</w:p>")
        if 0 <= i < j:
            frag = s[i : j + 6]
            return (s[:i] + "<w:p>" * 200 + frag + "</w:p>" * 200 + s[j + 6 :]).encode()
    if kind == 5:  # entity bomb / external entity
        bomb = '<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c SYSTEM "file:///etc/passwd">]>'
        return s.replace("?>", "?>" + bomb, 1).replace("<w:t>", "<w:t>&b;&c;", 1).encode()
    if kind == 6:  # strip all text nodes' content / empty runs
        return s.replace("</w:t>", "").encode()
    if kind == 7:  # invalid attribute junk and weird ids
        return s.replace("<w:p>", '<w:p w:id="999999999999999999999" junk="\x01">', 3).encode(
            "utf-8", "replace"
        )
    return s.replace("w:", "x:").encode()


def mutate_zip(rng: random.Random, m: dict[str, bytes], raw: bytes) -> bytes:
    kind = rng.randrange(6)
    names = [n for n in m if n.endswith((".xml", ".rels"))]
    if kind == 0:
        return raw[: rng.randrange(len(raw))]
    if kind == 1:
        b = bytearray(raw)
        for _ in range(rng.randrange(1, 30)):
            b[rng.randrange(len(b))] = rng.randrange(256)
        return bytes(b)
    m = dict(m)
    if kind == 2:
        m.pop(rng.choice(names))
    elif kind == 3:
        m[rng.choice(names)] = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 200)))
    elif kind == 4:
        m[rng.choice(names)] = b""
    else:
        for n in rng.sample(names, k=min(3, len(names))):
            m[n] = mutate_xml(rng, m[n])
    return build_zip(m)


def run_all(path, db_path, tmp):
    pipe = TashkeelPipeline(MockEngine(), level="full")
    for fn in (
        lambda: extract_plain_text(path),
        lambda: process_docx(path, tmp / "o1.docx", pipe, db_path, True),
        lambda: process_docx_tracked(path, tmp / "o2.docx", pipe, db_path, True),
    ):
        try:
            fn()
        except MizajError as e:
            assert e.error_code in ALLOWED, e.error_code


@pytest.mark.skipif(not hasattr(signal, "SIGALRM"), reason="needs SIGALRM")
@pytest.mark.parametrize("builder", [build_rich_docx, build_tab_marks_docx])
def test_fuzz_docx(tmp_path, data_dir, builder):
    from app.core.migrations import run_migrations

    db_path = data_dir / "mizaj.db"
    run_migrations(db_path, data_dir / "b")
    connect(db_path).close()
    base = builder(tmp_path / "base.docx")
    m, raw = members(base), base.read_bytes()
    rng = random.Random(SEED)
    signal.signal(signal.SIGALRM, _alarm)
    failures = []
    for n in range(CASES):
        if rng.random() < 0.4:
            data = mutate_zip(rng, m, raw)
        else:
            mm = dict(m)
            for name in rng.sample([k for k in mm if k.endswith(".xml")], k=2):
                mm[name] = mutate_xml(rng, mm[name])
            data = build_zip(mm)
        f = tmp_path / f"fuzz{n}.docx"
        f.write_bytes(data)
        signal.alarm(TIMEOUT)
        try:
            run_all(f, db_path, tmp_path)
        except Timeout:
            failures.append((n, "TIMEOUT"))
        except Exception as e:  # noqa: BLE001
            failures.append((n, f"{type(e).__name__}: {e}"[:200]))
        finally:
            signal.alarm(0)
    assert not failures, failures[:10]


def test_not_a_zip_and_empty(tmp_path, data_dir):
    for i, data in enumerate((b"", b"PK\x03\x04", b"\x00" * 100, b"hello")):
        f = tmp_path / f"x{i}.docx"
        f.write_bytes(data)
        with pytest.raises(MizajError) as e:
            extract_plain_text(f)
        assert e.value.error_code == "ERR_DOCX_CORRUPT"
