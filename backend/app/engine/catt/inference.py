# Derived from CATTEncoderOnly in catt-tashkeel 1.0.2 (Apache-2.0, see NOTICE).
"""Encoder-only CATT ONNX inference (CPU, thread-constrained per threading-model.md)."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import onnxruntime as ort

from .tokenizer import TashkeelTokenizer


def make_session_options() -> ort.SessionOptions:
    cpu_cores = os.cpu_count() or 4
    opts = ort.SessionOptions()
    # Prevent thread oversubscription on dual/quad-core CPUs
    opts.intra_op_num_threads = max(1, cpu_cores // 2)
    opts.inter_op_num_threads = 1
    opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return opts


class CATTEncoderOnly:
    def __init__(self, encoder_path: Path, decoder_path: Path) -> None:
        for p in (encoder_path, decoder_path):
            if not Path(p).exists():
                raise FileNotFoundError(str(p))
        self.tokenizer = TashkeelTokenizer()
        self.pad_idx = self.tokenizer.letters_map["<PAD>"]
        opts = make_session_options()
        providers = ["CPUExecutionProvider"]
        self.encoder = ort.InferenceSession(str(encoder_path), opts, providers=providers)
        self.decoder = ort.InferenceSession(str(decoder_path), opts, providers=providers)

    def _pad_mask(self, ids: np.ndarray) -> np.ndarray:
        keep = ids != self.pad_idx
        return keep[:, None, None, :] & keep[:, None, :, None]

    def _run(self, texts: list[str], want_conf: bool):
        encoded = [self.tokenizer.encode(t, test_match=False)[0] for t in texts]
        max_len = max(len(e) for e in encoded)
        ids = np.full((len(encoded), max_len), self.pad_idx, dtype=np.int64)
        for i, e in enumerate(encoded):
            ids[i, : len(e)] = e
        inner = ids[:, 1:-1]  # drop BOS/EOS
        enc = self.encoder.run(None, {"src": inner, "src_mask": self._pad_mask(inner)})[0]
        logits = self.decoder.run(None, {"enc_src": enc})[0]
        preds = np.argmax(logits, axis=-1)
        space = inner == self.tokenizer.letters_map[" "]
        conf = None
        if want_conf:
            # softmax probability of the chosen class, per input position
            z = logits - logits.max(axis=-1, keepdims=True)
            e = np.exp(z)
            conf = e.max(axis=-1) / e.sum(axis=-1)
        preds[space] = self.tokenizer.tashkeel_map[self.tokenizer.no_tashkeel_tag]
        return inner, preds, space, conf

    def diacritize_batch(self, texts: list[str]) -> list[str]:
        """`texts` must contain only Arabic letters and single spaces."""
        inner, preds, _, _ = self._run(texts, False)
        return self.tokenizer.decode(inner, preds)

    def diacritize_scored(self, text: str) -> tuple[str, list[float]]:
        """Diacritized text and, per non-space input letter, the model's softmax confidence."""
        inner, preds, space, conf = self._run([text], True)
        out = self.tokenizer.decode(inner, preds)[0]
        keep = ~space[0] & (inner[0] != self.pad_idx)
        return out, [float(c) for c in conf[0][keep]]

    def diacritize(self, text: str) -> str:
        return self.diacritize_batch([text])[0]
