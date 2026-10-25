"""Detect free local tools: LanguageTool server, Tesseract (7.8.4)."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from app.resources import net

LT_DEFAULT = "http://127.0.0.1:8081"
WIN_TESSERACT = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Tesseract-OCR" / "tesseract.exe"),
]
INSTALL_HINT = (
    "Install Tesseract OCR (Apache-2.0) with the Arabic language data "
    "(Windows: UB-Mannheim build, tick 'Arabic'; Linux: apt install tesseract-ocr "
    "tesseract-ocr-ara; macOS: brew install tesseract tesseract-lang)."
)


def languagetool_url() -> str:
    return os.environ.get("MIZAJ_LANGUAGETOOL_URL", LT_DEFAULT)


def detect_languagetool(timeout: float = 0.5, data_dir: Path | None = None) -> dict[str, Any]:
    url = languagetool_url()
    jar, java = find_languagetool_jar(data_dir), find_java(data_dir)
    # files present on disk (downloaded + extracted) even when the server is not running yet
    local = {"installed_files": bool(jar), "jar": jar, "java": java}
    try:
        data = net.local_request(url, "/v2/languages", timeout=timeout)
        arabic = any(
            isinstance(lang, dict) and str(lang.get("longCode", "")).startswith("ar")
            for lang in data
        )
        return {"detected": True, "url": url, "arabic": arabic, **local}
    except Exception as exc:  # noqa: BLE001
        return {
            "detected": False, "url": url, "arabic": False, "reason": type(exc).__name__, **local,
        }  # fmt: skip


_DATA_DIR: Path | None = None


def set_data_dir(path: Path | None) -> None:
    """The app data dir, so extracted resources are found by every caller (OCR included)."""
    global _DATA_DIR
    _DATA_DIR = Path(path) if path else None


def tesseract_env(binary: str) -> dict[str, str]:
    """Child environment (no API token); an extracted Tesseract finds its `tessdata` folder."""
    env = {k: v for k, v in os.environ.items() if k != "MIZAJ_API_TOKEN"}
    td = Path(binary).parent / "tessdata"
    if td.is_dir() and "TESSDATA_PREFIX" not in env:
        env["TESSDATA_PREFIX"] = str(td)
    return env


def _exe(name: str) -> tuple[str, ...]:
    return (name + ".exe", name) if os.name == "nt" else (name, name + ".exe")


def find_extracted(
    data_dir: Path | None, names: tuple[str, ...], max_depth: int = 4
) -> Path | None:
    """First file called one of `names` inside an installed resource (<data>/resources/*), found
    at any depth up to `max_depth`: archives unpack to arbitrary sub-folders."""
    data_dir = data_dir or _DATA_DIR
    if data_dir is None:
        return None
    root = Path(data_dir) / "resources"
    try:
        stack = [(d, 0) for d in sorted(root.iterdir()) if d.is_dir()]
    except OSError:
        return None
    while stack:
        d, depth = stack.pop(0)
        try:
            kids = sorted(d.iterdir())
        except OSError:
            continue
        for k in kids:
            if k.is_file() and k.name.lower() in names:
                return k
        if depth < max_depth:
            stack.extend((k, depth + 1) for k in kids if k.is_dir() and not k.is_symlink())
    return None


def find_java(data_dir: Path | None = None) -> str | None:
    """Java for a local LanguageTool: one extracted by a resource first, else the system one."""
    own = find_extracted(data_dir, _exe("java"))
    if own is not None and own.parent.name == "bin":
        return str(own)
    return shutil.which("java")


def find_languagetool_jar(data_dir: Path | None = None) -> str | None:
    jar = find_extracted(data_dir, ("languagetool-server.jar",))
    return str(jar) if jar else None


def find_tesseract(data_dir: Path | None = None) -> str | None:
    env = os.environ.get("MIZAJ_TESSERACT")
    if env and Path(env).is_file():
        return env
    own = find_extracted(data_dir, _exe("tesseract"))
    if own is not None:
        return str(own)
    found = shutil.which("tesseract")
    if found:
        return found
    return next((p for p in WIN_TESSERACT if p and Path(p).is_file()), None)


def tesseract_languages(binary: str) -> list[str]:
    try:
        out = subprocess.run(
            [binary, "--list-langs"], capture_output=True, text=True, timeout=15, check=False,
            shell=False, stdin=subprocess.DEVNULL,
            env=tesseract_env(binary),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return []
    lines = (out.stdout + "\n" + out.stderr).splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.startswith("List of")]


def detect_tesseract(data_dir: Path | None = None) -> dict[str, Any]:
    binary = find_tesseract(data_dir)
    if not binary:
        return {"detected": False, "path": None, "languages": [], "hint": INSTALL_HINT}
    langs = tesseract_languages(binary)
    return {
        "detected": True,
        "path": binary,
        "languages": langs,
        "arabic": "ara" in langs,
        "hint": None if "ara" in langs else INSTALL_HINT,
    }


def detect_all(data_dir: Path | None = None) -> dict[str, Any]:
    return {
        "languagetool": detect_languagetool(data_dir=data_dir),
        "tesseract": detect_tesseract(data_dir),
    }
