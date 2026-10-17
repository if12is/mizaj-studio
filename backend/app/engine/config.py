"""Engine-mode and model-location helpers (read lazily so tests can monkeypatch)."""

from __future__ import annotations

import os
from pathlib import Path

MODELS_DIR = Path(__file__).resolve().parent.parent.parent / "models"
CATT_DIR = MODELS_DIR / "catt_eo"


def catt_encoder_path() -> Path:
    return CATT_DIR / "encoder.onnx"


def catt_decoder_path() -> Path:
    return CATT_DIR / "decoder.onnx"


def model_present() -> bool:
    return catt_encoder_path().exists()


def env_mock() -> bool:
    return os.environ.get("MIZAJ_ENGINE_MODE", "").lower() == "mock"


def is_mock() -> bool:
    """Reported engine mode: mock if env says so or the CATT encoder is missing."""
    return env_mock() or not model_present()


def morph_filter_default() -> bool:
    return os.environ.get("MIZAJ_MORPH_FILTER", "1").lower() not in ("0", "false", "off", "no")
