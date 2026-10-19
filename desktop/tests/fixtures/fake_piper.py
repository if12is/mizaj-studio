#!/usr/bin/env python3
"""Fake piper for the read-aloud E2E (unpackaged builds only, MIZAJ_E2E_FAKE_PIPER).

Reads the text from STDIN, appends it to $FAKE_PIPER_LOG (with the argv), and writes a tiny valid
WAV (2.5 s of silence, 22.05 kHz mono 16-bit) to --output_file. `FAKE_PIPER_FAIL=1` exits 3.
"""
import os
import struct
import sys

args = sys.argv[1:]
text = sys.stdin.buffer.read().decode("utf-8")
log = os.environ.get("FAKE_PIPER_LOG")
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(repr({"argv": args, "stdin": text}) + "\n")
if os.environ.get("FAKE_PIPER_FAIL") == "1" or (os.environ.get("FAKE_PIPER_FAIL_ON") or "\0") in text:
    sys.exit(3)
out = args[args.index("--output_file") + 1]
n = int(22050 * float(os.environ.get("FAKE_PIPER_SECONDS", "2.5")))
data = b"\x00\x00" * n
hdr = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 22050, 44100, 2, 16)
with open(out, "wb") as f:
    f.write(hdr + b"data" + struct.pack("<I", len(data)) + data)
