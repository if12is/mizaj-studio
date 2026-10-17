"""Accurate-mode engine: CATT encoder-only ONNX (vendored inference)."""

from __future__ import annotations

import logging
import threading

from app.engine import config
from app.engine.base import Engine, Lookup
from app.engine.catt.inference import CATTEncoderOnly
from app.engine.normalize import split_pairs

log = logging.getLogger("mizaj.engine.catt")


class CattEngine(Engine):
    name = "catt"
    cache_tag = "catt"

    def __init__(self) -> None:
        self._model = CATTEncoderOnly(config.catt_encoder_path(), config.catt_decoder_path())
        self._lock = threading.Lock()  # one ORT run at a time; ORT itself is also threaded
        log.info("CATT encoder loaded from %s", config.catt_encoder_path())

    def diacritize(self, words: list[str], lookup: Lookup | None = None) -> list[str]:
        if not words:
            return []
        with self._lock:
            out = self._model.diacritize(" ".join(words)).split(" ")
        if len(out) != len(words):
            log.warning("CATT word count mismatch (%d vs %d)", len(out), len(words))
            with self._lock:
                out = [self._model.diacritize(w) for w in words]
        # normalise mark order per letter
        return ["".join(b + m for b, m in split_pairs(w)) for w in out]

    def diacritize_scored(self, words, lookup=None):
        if not words:
            return [], []
        with self._lock:
            text, letter_conf = self._model.diacritize_scored(" ".join(words))
        out = text.split(" ")
        if len(out) != len(words) or len(letter_conf) != sum(len(w) for w in words):
            return self.diacritize(words, lookup), [None] * len(words)
        confs, pos = [], 0
        for w in words:
            lc = letter_conf[pos : pos + len(w)]
            pos += len(w)
            confs.append((min(lc), lc[-1]))  # weakest letter / the case-ending letter
        return ["".join(b + m for b, m in split_pairs(w)) for w in out], confs

    def is_ambiguous(self, word: str) -> bool:
        raise NotImplementedError("use the mishkal oracle")
