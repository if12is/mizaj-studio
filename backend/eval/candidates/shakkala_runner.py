"""Standalone Shakkala runner (MIT, Ahmad Barqawi) - executed with a Python that has
TensorFlow + the `shakkala` wheel installed, NOT with the sidecar's interpreter:

    echo '["ذهب الولد إلى المدرسة"]' | python shakkala_runner.py

stdin: JSON list of undiacritized sentences; stdout: JSON list of diacritized sentences.
"""

import json
import os
import sys
import time

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")


def pieces(s: str, limit: int = 300):
    out, cur = [], ""
    for w in s.split(" "):
        if len(cur) + len(w) + 1 > limit and cur:
            out.append(cur)
            cur = w
        else:
            cur = (cur + " " + w) if cur else w
    out.append(cur)
    return out


def main() -> int:
    from shakkala import Shakkala

    sentences = json.load(sys.stdin)
    shk = Shakkala(version=3)
    model, _ = shk.get_model()
    result = []
    t0 = time.time()
    for s in sentences:
        parts = []
        for piece in pieces(s):
            if not piece.strip():
                parts.append(piece)
                continue
            inp = shk.prepare_input(piece)
            logits = model.predict(inp, verbose=0)[0]
            text = shk.logits_to_text(logits)
            parts.append(shk.get_final_text(piece, text))
        result.append(" ".join(parts))
    print(json.dumps({"outputs": result, "seconds": time.time() - t0}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
