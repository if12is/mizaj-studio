"""Legacy Word -> .docx conversion: fallback order, comtypes path and the text-only converter.

Platform-specific parts (Windows, Word COM) are mocked so this runs on Linux and Windows CI.
"""
from __future__ import annotations

import shutil
import sys
import types
from pathlib import Path

import pytest
from docx import Document

from app.core.errors import MizajError
from app.docx import convert

FIXTURE = Path(__file__).parent / "fixtures" / "legacy_sample.doc"


@pytest.fixture()
def src(tmp_path: Path) -> Path:
    p = tmp_path / "in" / "sample.doc"
    p.parent.mkdir()
    shutil.copy(FIXTURE, p)
    return p


def _write_docx(dst: Path) -> None:
    d = Document()
    d.add_paragraph("converted")
    d.save(str(dst))


def _install_fake_comtypes(monkeypatch, create_object):
    calls = {"init": 0, "uninit": 0}
    ct = types.ModuleType("comtypes")
    ct.CoInitialize = lambda: calls.__setitem__("init", calls["init"] + 1)
    ct.CoUninitialize = lambda: calls.__setitem__("uninit", calls["uninit"] + 1)
    client = types.ModuleType("comtypes.client")
    client.CreateObject = create_object
    ct.client = client
    monkeypatch.setitem(sys.modules, "comtypes", ct)
    monkeypatch.setitem(sys.modules, "comtypes.client", client)
    return calls


class FakeWord:
    instances: list[FakeWord] = []

    def __init__(self, saveas2_fails=False):
        self.saveas2_fails = saveas2_fails
        self.quit_called = False
        self.closed: list = []
        self.opened: tuple = ()
        self.saved_format = None
        self.Visible = True
        self.DisplayAlerts = -1
        self.Documents = self
        FakeWord.instances.append(self)

    def Open(self, *args):
        self.opened = args
        app = self

        class Doc:
            def SaveAs2(self, path, fmt):
                if app.saveas2_fails:
                    raise RuntimeError("SaveAs2 not supported")
                app.saved_format = fmt
                _write_docx(Path(path))

            def SaveAs(self, path, fmt):
                app.saved_format = fmt
                _write_docx(Path(path))

            def Close(self, save):
                app.closed.append(save)

        return Doc()

    def Quit(self):
        self.quit_called = True


def test_word_via_comtypes(monkeypatch, src, tmp_path):
    FakeWord.instances.clear()
    monkeypatch.setattr(sys, "platform", "win32")
    calls = _install_fake_comtypes(monkeypatch, lambda prog_id, **kw: FakeWord())
    out, method = convert.convert_legacy(src, tmp_path / "data")
    assert method == "word"
    assert out.parent == tmp_path / "data" / "converted" and out.suffix == ".docx"
    assert Document(str(out)).paragraphs[0].text == "converted"
    w = FakeWord.instances[0]
    assert w.opened[1:] == (False, True, False)  # ConfirmConversions, ReadOnly, AddToRecentFiles
    assert w.saved_format == 16 and w.closed == [False] and w.quit_called
    assert w.Visible is False and w.DisplayAlerts == 0
    assert calls == {"init": 1, "uninit": 1}
    # cached on the second call
    out2, method2 = convert.convert_legacy(src, tmp_path / "data")
    assert out2 == out and method2 == "word"


def test_comtypes_saveas_fallback_and_wps_progid(monkeypatch, src, tmp_path):
    FakeWord.instances.clear()
    tried: list[str] = []

    def create(prog_id, **kw):
        tried.append(prog_id)
        if prog_id == "Word.Application":
            raise OSError("Class not registered")
        return FakeWord(saveas2_fails=True)

    monkeypatch.setattr(sys, "platform", "win32")
    _install_fake_comtypes(monkeypatch, create)
    _, method = convert.convert_legacy(src, tmp_path / "data")
    assert method == "word"
    assert tried == ["Word.Application", "KWPS.Application"]
    assert FakeWord.instances[0].saved_format == 12


def test_fallback_order_when_com_fails(monkeypatch, src, tmp_path, caplog):
    order: list[str] = []
    monkeypatch.setattr(sys, "platform", "win32")

    def boom(prog_id, **kw):
        raise OSError("no word")

    _install_fake_comtypes(monkeypatch, boom)

    def ps(s, d):
        order.append("ps")
        return False

    def lo(s, d):
        order.append("lo")
        _write_docx(d)
        return True

    monkeypatch.setattr(convert, "_convert_word_powershell", ps)
    monkeypatch.setattr(convert, "_convert_libreoffice", lo)
    with caplog.at_level("WARNING", logger="mizaj.docx"):
        _, method = convert.convert_legacy(src, tmp_path / "data")
    assert method == "libreoffice" and order == ["ps", "lo"]
    assert "no word" in caplog.text


def test_com_timeout_gives_up(monkeypatch, src, tmp_path):
    import threading

    release = threading.Event()
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(convert, "COM_TIMEOUT_S", 0.2)
    _install_fake_comtypes(monkeypatch, lambda prog_id, **kw: release.wait(5))
    monkeypatch.setattr(convert, "_convert_word_powershell", lambda s, d: False)
    monkeypatch.setattr(convert, "_convert_libreoffice", lambda s, d: False)
    try:
        _, method = convert.convert_legacy(src, tmp_path / "data")
    finally:
        release.set()
    assert method == "text_only"


def test_non_windows_skips_word(monkeypatch, src, tmp_path):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(convert, "_convert_word_comtypes", lambda s, d: pytest.fail("com"))
    monkeypatch.setattr(convert, "_convert_word_powershell", lambda s, d: pytest.fail("ps"))
    monkeypatch.setattr(convert, "_find_soffice", lambda: None)
    out, method = convert.convert_legacy(src, tmp_path / "data")
    assert method == "text_only" and out.is_file()


def test_text_only_real_doc(monkeypatch, src, tmp_path):
    monkeypatch.setattr(convert, "_find_soffice", lambda: None)
    out, method = convert.convert_legacy(src, tmp_path / "data")
    assert method == "text_only"
    paras = Document(str(out)).paragraphs
    texts = [p.text for p in paras]
    assert "مرحبا بالعالم، هذا اختبار" in texts and "Plain English line" in texts
    ar = next(p for p in paras if p.text.startswith("مرحبا"))
    xml = ar._p.xml
    assert "w:bidi" in xml and "w:rtl" in xml and "Simplified Arabic" in xml
    assert "w:cs=" in xml
    en = next(p for p in paras if p.text.startswith("Plain"))
    assert "w:bidi" not in en._p.xml


def test_all_fail_raises_validation_error(monkeypatch, tmp_path):
    monkeypatch.setattr(convert, "_find_soffice", lambda: None)
    rtf = tmp_path / "x.rtf"
    rtf.write_text("{\\rtf1 hi}")
    with pytest.raises(MizajError) as ei:
        convert.convert_legacy(rtf, tmp_path / "data")
    assert ei.value.error_code == "ERR_VALIDATION"


def test_powershell_command_shape(monkeypatch, src, tmp_path):
    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"], seen["env"] = cmd, kw["env"]
        _write_docx(Path(kw["env"]["MZ_OUT"]))
        return types.SimpleNamespace(returncode=0, stderr=b"", stdout=b"")

    monkeypatch.setattr(convert.subprocess, "run", fake_run)
    dst = tmp_path / "o.docx"
    assert convert._convert_word_powershell(src, dst)
    assert "-Command" in seen["cmd"] and "-EncodedCommand" not in seen["cmd"]
    assert seen["env"]["MZ_IN"] == str(src)
