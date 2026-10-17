# Packaging the sidecar (Task 5.1) - measured numbers

Build: `python scripts/build_backend.py` (PyInstaller 6.5.0, one-folder, spec: `mizaj_engine.spec`).
Measured on Linux x86-64, Python 3.11, onnxruntime 1.17.1 (CPU wheel), numpy 1.26.4.

## Size (the plan estimated 220-280 MB incl. a 42 MB INT8 model; reality differs)

| What | Size |
| :--- | ---: |
| `dist/mizaj-engine/` uncompressed (378 files) | **177 MB** |
| same folder zipped (`zip -9`) | **70 MB** |
| CATT model (`encoder.onnx` + `decoder.onnx`, float - **not** INT8, **not bundled in the exe**) | 78 MB (72 MB zipped) |

Models ship separately (electron-builder `extraResources` -> `<exe dir>/models/catt_eo`, or a
`.mizajpack`), so installed total = 177 + 78 = ~255 MB for the backend.

Biggest items in `_internal/` (MB, uncompressed):

| Item | MB | Notes |
| :--- | ---: | :--- |
| `numpy.libs` | 37 | OpenBLAS shipped with numpy 1.26; needed by onnxruntime |
| `data/` | 34 | sqlite dictionaries: arramooz `arabicdictionary` 15, asmai `semantic` 13, `wordfreq` 4, `stopwords` 3 |
| `lxml` | 19 | python-docx dependency |
| `onnxruntime` | 16 | CPU provider only (`libonnxruntime_providers_shared.so` is 1 MB; nothing to strip) |
| `mizaj-engine` (bootloader+PYZ) | 11 | all pure-python modules |
| `numpy` | 11 | |
| `libpython3.11` | 8 | |
| `arabicstopwords` | 7 | |
| `pydantic_core` | 6 | |
| tashaphyne / qalsadi / mishkal | 5 / 5 / 5 | |
| `docx` | 2 | default template etc. |

What was trimmed (saved 22 MB, 199 -> 177 MB): `maskouk` collocation databases (22 MB, never queried
on our paths - checked with the frozen binary: fast, accurate, word-suggestions, docx export);
excluded `sympy`/`mpmath` (~85 MB, only used by onnxruntime's offline tools), `onnxruntime.tools/
transformers/quantization`, `pkg_resources`/setuptools, tkinter, test directories and `.pyi`/`.md`.
Not safe to drop: `asmai/semantic.sqlite` (fast mode fails without it), `numpy.libs`.

## Frozen-build gotchas (all handled in the spec)
- arramooz/asmai/qalsadi have a py2exe branch: when `sys.frozen` is set they open
  `<sys.prefix>/data/<name>.sqlite`. The spec relocates those files to `_internal/data/`.
- `libtashkeel` is not on PyPI and is not bundled; fast mode = mishkal.
- `qalsadi`/`sylajone` may create `~/.thaalabCache` in the user's home directory.
- `multiprocessing.freeze_support()` is called in `engine_entry.py`.

## Model location (resolved at runtime, first existing `encoder.onnx` wins)
1. `$MIZAJ_MODELS_DIR` (the `catt_eo` dir itself or its parent)
2. `<data-dir>/models/catt_eo` (where `.mizajpack` updates install)
3. `<exe dir>/models/catt_eo` (installer `extraResources`)
4. `backend/models/catt_eo` (dev)

`GET /health` reports `models_dir`; `GET /api/packs/status` also reports the source.

## Frozen-binary smoke (Linux)
Handshake `MIZAJ_PORT` / `MIZAJ_STATUS=READY`, `/health`, fast + accurate `/api/tashkeel`,
`/api/docx/export` (sample_mixed accurate full+minimal, sample_ar fast), `/api/word-suggestions`,
`/api/packs/apply` (engine_mode mock -> real, then accurate works), models from `<exe dir>/models`.

## Memory (Task 5.2.4) - `python scripts/stress_memory.py [--exe ...]`
`sample_long.txt` (32,940 words, 1,220 chunks) streamed with `use_cache:false`, RSS sampled every 0.5 s:

| Mode | Baseline | Peak RSS | Time | Target |
| :--- | ---: | ---: | ---: | :--- |
| fast (dev) | 59 MB | 145 MB | 56 s | < 500 MB |
| accurate (dev, CATT + morph filter) | 58 MB | 333 MB | 60 s | < 500 MB |
| fast (frozen) | 62 MB | 148 MB | 61 s | < 500 MB |
| accurate (frozen) | 62 MB | 335 MB | 54 s | < 500 MB |

Memory is flat after the model loads (end RSS ~= peak, no growth across 1,220 chunks), so no
ONNX session-option changes were needed.
