"""Engine-mode and model-location helpers (read lazily so tests can monkeypatch)."""

from __future__ import annotations

import os
import sys
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent.parent / "models"
CATT_DIR = MODELS_DIR / "catt_eo"  # dev location (backend/models/catt_eo)
SUBDIR = "catt_eo"

_data_dir: Path | None = None


def set_data_dir(path: Path | None) -> None:
    """Called by create_app so models installed under <data-dir>/models are found."""
    global _data_dir
    _data_dir = Path(path) if path is not None else None


def get_data_dir() -> Path | None:
    return _data_dir


def exe_dir() -> Path | None:
    """Directory of the frozen executable (PyInstaller), None when running from source."""
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else None


def _has_encoder(d: Path) -> bool:
    return (d / "encoder.onnx").exists()


def model_dir_candidates() -> list[tuple[str, Path]]:
    """Resolution order: env MIZAJ_MODELS_DIR, <data-dir>/models/catt_eo,
    <exe dir>/models/catt_eo (packaged extraResources), backend/models/catt_eo (dev)."""
    out: list[tuple[str, Path]] = []
    env = os.environ.get("MIZAJ_MODELS_DIR")
    if env:
        root = Path(env)
        out.append(("env", root if _has_encoder(root) else root / SUBDIR))
    if _data_dir is not None:
        out.append(("data-dir", _data_dir / "models" / SUBDIR))
    exe = exe_dir()
    if exe is not None:
        out.append(("exe", exe / "models" / SUBDIR))
    out.append(("dev", CATT_DIR))
    return out


def resolve_model_dir() -> tuple[str, Path]:
    """(source, dir) of the first candidate that has encoder.onnx; else the dev location."""
    for source, d in model_dir_candidates():
        if _has_encoder(d):
            return source, d
    return "dev", CATT_DIR


def catt_dir() -> Path:
    return resolve_model_dir()[1]


def catt_encoder_path() -> Path:
    return catt_dir() / "encoder.onnx"


def catt_decoder_path() -> Path:
    return catt_dir() / "decoder.onnx"


def model_present() -> bool:
    return catt_encoder_path().exists()


def env_mock() -> bool:
    return os.environ.get("MIZAJ_ENGINE_MODE", "").lower() == "mock"


def is_mock() -> bool:
    """Reported engine mode: mock if env says so or the CATT encoder is missing."""
    return env_mock() or not model_present()


def morph_filter_default() -> bool:
    return os.environ.get("MIZAJ_MORPH_FILTER", "1").lower() not in ("0", "false", "off", "no")
