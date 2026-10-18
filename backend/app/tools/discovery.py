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


def detect_languagetool(timeout: float = 0.5) -> dict[str, Any]:
    url = languagetool_url()
    try:
        data = net.local_request(url, "/v2/languages", timeout=timeout)
        arabic = any(
            isinstance(lang, dict) and str(lang.get("longCode", "")).startswith("ar")
            for lang in data
        )
        return {"detected": True, "url": url, "arabic": arabic}
    except Exception as exc:  # noqa: BLE001
        return {"detected": False, "url": url, "arabic": False, "reason": type(exc).__name__}


def find_tesseract() -> str | None:
    env = os.environ.get("MIZAJ_TESSERACT")
    if env and Path(env).is_file():
        return env
    found = shutil.which("tesseract")
    if found:
        return found
    return next((p for p in WIN_TESSERACT if p and Path(p).is_file()), None)


def tesseract_languages(binary: str) -> list[str]:
    try:
        out = subprocess.run(
            [binary, "--list-langs"], capture_output=True, text=True, timeout=15, check=False,
            shell=False, stdin=subprocess.DEVNULL,
            env={k: v for k, v in os.environ.items() if k != "MIZAJ_API_TOKEN"},
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError):
        return []
    lines = (out.stdout + "\n" + out.stderr).splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.startswith("List of")]


def detect_tesseract() -> dict[str, Any]:
    binary = find_tesseract()
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


def detect_all() -> dict[str, Any]:
    return {
        "languagetool": detect_languagetool(),
        "tesseract": detect_tesseract(),
    }
