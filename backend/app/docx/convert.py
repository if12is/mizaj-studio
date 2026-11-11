"""Legacy Word (.doc/.rtf/.odt/.docm) -> .docx conversion that keeps the original formatting.

Order of attempts (first one that yields a non-empty .docx wins):
  1. Windows: in-process COM via ``comtypes`` (Word, then WPS Office), guarded by a timeout.
  2. Windows: PowerShell + COM (``-Command``, absolute powershell.exe path, paths via env vars).
  3. LibreOffice (``soffice --headless``) from PATH or the usual install directories.
  4. Built-in text-only converter (``.doc`` only): formatting is lost.
Every failed attempt is logged at WARNING with its reason.
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from app.core.errors import validation_error

log = logging.getLogger("mizaj.docx")

WORD_PROGIDS = ("Word.Application", "KWPS.Application", "wps.Application")
COM_TIMEOUT_S = 90
PS_TIMEOUT_S = 120
SOFFICE_TIMEOUT_S = 180


def _ok(p: Path) -> bool:
    return p.is_file() and p.stat().st_size > 0


# --------------------------------------------------------------------------- 1. comtypes
def _com_convert_worker(src: Path, dst: Path, result: dict) -> None:
    import comtypes  # lazy: Windows only
    import comtypes.client

    comtypes.CoInitialize()
    errors: list[str] = []
    try:
        for prog_id in WORD_PROGIDS:
            app = None
            try:
                # dynamic=True: late-bound IDispatch, no comtypes.gen wrappers (read-only in the frozen app)
                app = comtypes.client.CreateObject(prog_id, dynamic=True)
                try:
                    app.Visible = False
                except Exception:  # noqa: BLE001
                    pass
                try:
                    app.DisplayAlerts = 0
                except Exception:  # noqa: BLE001
                    pass
                doc = None
                try:
                    # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles
                    doc = app.Documents.Open(str(src), False, True, False)
                    try:
                        doc.SaveAs2(str(dst), 16)  # wdFormatDocumentDefault
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"{prog_id} SaveAs2: {exc!r}")
                        doc.SaveAs(str(dst), 12)  # wdFormatXMLDocument
                finally:
                    if doc is not None:
                        try:
                            doc.Close(False)
                        except Exception:  # noqa: BLE001
                            pass
                if _ok(dst):
                    result["ok"] = True
                    return
                errors.append(f"{prog_id}: no output produced")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{prog_id}: {exc!r}")
            finally:
                if app is not None:
                    try:
                        app.Quit()
                    except Exception:  # noqa: BLE001
                        pass
        result["error"] = "; ".join(errors) or "no COM application available"
    except Exception as exc:  # noqa: BLE001
        result["error"] = repr(exc)
    finally:
        try:
            comtypes.CoUninitialize()
        except Exception:  # noqa: BLE001
            pass


def _convert_word_comtypes(src: Path, dst: Path) -> bool:
    try:
        import comtypes  # noqa: F401
    except Exception as exc:  # noqa: BLE001
        log.warning("comtypes unavailable: %r", exc)
        return False
    result: dict = {}
    t = threading.Thread(
        target=_com_convert_worker, args=(src, dst, result), name="mizaj-com", daemon=True
    )
    t.start()
    t.join(COM_TIMEOUT_S)
    if t.is_alive():
        log.warning(
            "word comtypes convert timed out after %ss (modal dialog / Protected View?)",
            COM_TIMEOUT_S,
        )
        return False
    if result.get("ok") and _ok(dst):
        return True
    log.warning("word comtypes convert failed: %s", result.get("error", "unknown"))
    return False


# --------------------------------------------------------------------------- 2. PowerShell
_PS_SCRIPT = (
    "$ErrorActionPreference='Stop';"
    "foreach($id in 'Word.Application','KWPS.Application','wps.Application'){"
    "try{$w=New-Object -ComObject $id;"
    "try{$w.Visible=$false}catch{};try{$w.DisplayAlerts=0}catch{};"
    "try{$d=$w.Documents.Open($env:MZ_IN,$false,$true,$false);$o=$env:MZ_OUT;"
    "try{$d.SaveAs2($o,16)}catch{$d.SaveAs([ref]$o,[ref]12)};$d.Close($false)}"
    "finally{try{$w.Quit()}catch{}};"
    "if(Test-Path -LiteralPath $env:MZ_OUT){exit 0}"
    "}catch{[Console]::Error.WriteLine($id+': '+$_.Exception.Message)}};exit 1"
)


def _powershell_exe() -> str:
    root = os.environ.get("SystemRoot") or os.environ.get("windir") or r"C:\Windows"
    exe = Path(root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    return str(exe) if exe.is_file() else "powershell"


def _convert_word_powershell(src: Path, dst: Path) -> bool:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        r = subprocess.run(
            [_powershell_exe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-Command", _PS_SCRIPT],
            env={**os.environ, "MZ_IN": str(src), "MZ_OUT": str(dst)},
            capture_output=True, timeout=PS_TIMEOUT_S, creationflags=flags,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("word powershell convert error: %r", exc)
        return False
    if r.returncode != 0 or not _ok(dst):
        tail = (r.stderr or b"")[-500:].decode("utf-8", "replace").strip()
        log.warning("word powershell convert failed (rc=%s): %s", r.returncode, tail)
        return False
    return True


# --------------------------------------------------------------------------- 3. LibreOffice
def _find_soffice() -> str | None:
    found = shutil.which("soffice") or shutil.which("libreoffice")
    if found:
        return found
    if sys.platform == "win32":
        for var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
            base = os.environ.get(var)
            if base:
                cand = Path(base) / "LibreOffice" / "program" / "soffice.exe"
                if cand.is_file():
                    return str(cand)
        for base in (r"C:\Program Files", r"C:\Program Files (x86)"):
            cand = Path(base) / "LibreOffice" / "program" / "soffice.exe"
            if cand.is_file():
                return str(cand)
    return None


def _convert_libreoffice(src: Path, dst: Path) -> bool:
    soffice = _find_soffice()
    if not soffice:
        log.warning("libreoffice convert skipped: soffice not found")
        return False
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    with tempfile.TemporaryDirectory(prefix="mizaj-lo-") as tmp:
        tmp_p = Path(tmp)
        profile = (tmp_p / "profile").resolve().as_uri()
        try:
            r = subprocess.run(
                [soffice, f"-env:UserInstallation={profile}", "--headless", "--convert-to",
                 "docx", "--outdir", str(tmp_p / "out"), str(src)],
                capture_output=True, timeout=SOFFICE_TIMEOUT_S, creationflags=flags,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("libreoffice convert error: %r", exc)
            return False
        made = tmp_p / "out" / f"{src.stem}.docx"
        if r.returncode != 0 or not _ok(made):
            tail = ((r.stderr or b"") + (r.stdout or b""))[-500:].decode("utf-8", "replace")
            log.warning("libreoffice convert failed (rc=%s): %s", r.returncode, tail.strip())
            return False
        shutil.move(str(made), str(dst))
    return _ok(dst)


# --------------------------------------------------------------------------- 4. text only
def _convert_text_only(src: Path, dst: Path) -> bool:
    if src.suffix.lower() != ".doc":
        log.warning("text-only fallback skipped: only .doc is supported (got %s)", src.suffix)
        return False
    try:
        from app.docx.legacy import doc_to_docx

        doc_to_docx(src, dst)
    except Exception as exc:  # noqa: BLE001
        log.warning("builtin .doc conversion failed: %r", exc)
        return False
    return _ok(dst)


# --------------------------------------------------------------------------- entry point
def convert_legacy(src: Path, data_dir: Path) -> tuple[Path, str]:
    """Convert ``src`` to .docx under ``data_dir/converted``; returns (path, method)."""
    src = Path(src)
    out_dir = Path(data_dir) / "converted"
    out_dir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha1(f"{src}|{src.stat().st_mtime_ns}".encode()).hexdigest()[:10]
    out = out_dir / f"{src.stem[:80]}-{key}.docx"
    meta = out.with_suffix(".method")
    if _ok(out):
        try:
            method = meta.read_text(encoding="utf-8").strip()
        except OSError:
            method = ""
        return out, method if method in ("word", "libreoffice", "text_only") else "cached"

    attempts: list[tuple[str, object]] = []
    if sys.platform == "win32":
        attempts += [("word", _convert_word_comtypes), ("word", _convert_word_powershell)]
    attempts += [("libreoffice", _convert_libreoffice), ("text_only", _convert_text_only)]

    for method, fn in attempts:
        tmp = out_dir / f".~{key}-{os.getpid()}-{threading.get_ident()}.docx"
        tmp.unlink(missing_ok=True)
        try:
            if fn(src, tmp) and _ok(tmp):  # type: ignore[operator]
                os.replace(tmp, out)
                try:
                    meta.write_text(method, encoding="utf-8")
                except OSError:
                    pass
                return out, method
        except Exception as exc:  # noqa: BLE001
            log.warning("%s conversion crashed: %r", fn.__name__, exc)  # type: ignore[attr-defined]
        finally:
            tmp.unlink(missing_ok=True)
    raise validation_error(
        "could not convert the legacy Word file; save it as .docx in Word and import again",
        {"field": "path"},
        "تعذّر تحويل ملف Word القديم. افتحه في Word واحفظه بصيغة docx ثم استورده.",
    )
