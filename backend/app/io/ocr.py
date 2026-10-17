# ruff: noqa: E501
"""Offline OCR with a locally installed Tesseract (Apache-2.0) + pypdfium2 page rendering (7.3.7)."""

from __future__ import annotations

import csv
import io
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from app.core.errors import MizajError, validation_error
from app.tools import discovery

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}


def _missing() -> MizajError:
    return MizajError(
        "ERR_OCR_TESSERACT_MISSING", 424, "برنامج Tesseract غير مثبت على جهازك.",
        "Tesseract OCR was not found. " + discovery.INSTALL_HINT,
        {"hint": discovery.INSTALL_HINT},
    )  # fmt: skip


def require_tesseract(lang: str) -> str:
    binary = discovery.find_tesseract()
    if not binary:
        raise _missing()
    langs = discovery.tesseract_languages(binary)
    if langs and any(part not in langs for part in lang.split("+")):
        raise MizajError(
            "ERR_OCR_LANG_MISSING", 424, "بيانات اللغة العربية لـ Tesseract غير مثبتة.",
            f"Tesseract language data '{lang}' is missing. " + discovery.INSTALL_HINT,
            {"installed": langs, "hint": discovery.INSTALL_HINT},
        )  # fmt: skip
    return binary


def ocr_image_file(binary: str, image: Path, lang: str, timeout: int = 180) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [binary, str(image), "stdout", "-l", lang, "tsv"],
            capture_output=True, timeout=timeout, check=False,
        )  # fmt: skip
    except (OSError, subprocess.SubprocessError) as exc:
        raise MizajError(
            "ERR_OCR_FAILED", 500, "فشل التعرف الضوئي على الحروف.", f"Tesseract failed: {exc}", {}
        ) from exc
    if proc.returncode != 0:
        raise MizajError(
            "ERR_OCR_FAILED", 500, "فشل التعرف الضوئي على الحروف.",
            "Tesseract exited with an error.", {"stderr": proc.stderr.decode("utf-8", "replace")[-500:]},
        )  # fmt: skip
    rows = csv.DictReader(
        io.StringIO(proc.stdout.decode("utf-8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE
    )
    lines: dict[tuple[str, str, str, str], list[str]] = {}
    confs: list[float] = []
    for r in rows:
        txt = (r.get("text") or "").strip()
        try:
            conf = float(r.get("conf", "-1"))
        except ValueError:
            continue
        if not txt or conf < 0:
            continue
        key = (r["page_num"], r["block_num"], r["par_num"], r["line_num"])
        lines.setdefault(key, []).append(txt)
        confs.append(conf)
    # Tesseract emits Arabic words in reading order; join per line
    text = "\n".join(" ".join(ws) for ws in lines.values())
    return {"text": text, "confidence": round(sum(confs) / len(confs), 1) if confs else None,
            "words": len(confs)}  # fmt: skip


def ocr_path(
    path: Path, lang: str = "ara", dpi: int = 300, pages: list[int] | None = None,
    force_ocr: bool = False,
) -> dict[str, Any]:  # fmt: skip
    path = Path(path)
    if not path.is_absolute() or not path.is_file():
        raise validation_error("path must be an absolute path of an existing file")
    binary = require_tesseract(lang)
    ext = path.suffix.lower()
    out_pages: list[dict[str, Any]] = []
    if ext in IMAGE_EXT:
        r = ocr_image_file(binary, path, lang)
        out_pages.append({"page": 1, "method": "ocr", **r})
    elif ext == ".pdf":
        try:
            import pypdfium2 as pdfium
        except ImportError as exc:
            raise MizajError(
                "ERR_DEPENDENCY_MISSING", 501, "مكتبة pypdfium2 غير مثبتة.",
                "Optional dependency missing: pypdfium2 (Apache-2.0/BSD-3)", {},
            ) from exc  # fmt: skip
        try:
            pdf = pdfium.PdfDocument(str(path))
        except Exception as exc:  # noqa: BLE001
            raise MizajError(
                "ERR_FILE_INVALID", 422, "ملف PDF غير صالح.", f"Cannot open PDF: {exc}", {}
            ) from exc
        with tempfile.TemporaryDirectory(prefix="mizaj-ocr-") as tmp:
            for idx in range(len(pdf)):
                if pages and (idx + 1) not in pages:
                    continue
                page = pdf[idx]
                existing = ""
                if not force_ocr:
                    tp = page.get_textpage()
                    existing = tp.get_text_range().strip()
                if len(existing) >= 20:
                    out_pages.append({"page": idx + 1, "method": "text", "text": existing,
                                      "confidence": None, "words": len(existing.split())})  # fmt: skip
                    continue
                img = page.render(scale=dpi / 72).to_pil()
                f = Path(tmp) / f"p{idx + 1}.png"
                img.save(f)
                out_pages.append(
                    {"page": idx + 1, "method": "ocr", **ocr_image_file(binary, f, lang)}
                )
    else:
        raise validation_error("unsupported file type for OCR", {"ext": ext})
    confs = [p["confidence"] for p in out_pages if p["confidence"] is not None]
    return {
        "pages": out_pages,
        "text": "\n\n".join(p["text"] for p in out_pages),
        "confidence": round(sum(confs) / len(confs), 1) if confs else None,
        "language": lang,
        "tesseract": binary,
    }
