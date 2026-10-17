# Reproducible builds

Goal: the same commit produces the same files, so anyone can check that a published installer
matches the source. This is best effort: the Python engine and most of the app are deterministic,
Windows installers are not completely.

## What the workflows set

`.github/workflows/release.yml` and `windows-e2e.yml` run a "Reproducible-build environment" step:

| Variable | Value | Why |
| :--- | :--- | :--- |
| `SOURCE_DATE_EPOCH` | commit time (`git log -1 --format=%ct`) | Tools that honour it (Python `zipfile` via PyInstaller/wheel, many archivers, `electron-builder` for asar metadata) stamp this time instead of "now" |
| `PYTHONHASHSEED` | `0` | Fixed `set`/`dict` ordering of str keys in PyInstaller's analysis, so module tables and the TOC come out in a stable order |

The domain packs (`scripts/build_domain_packs.py`) are byte-for-byte reproducible by construction
(fixed zip timestamps and member order); CI checks this with `--check`.

Dependencies must be pinned (see `backend/requirements*.txt`, `desktop/package-lock.json`,
Python 3.11.7, Node 20.11.0) and the CATT models are sha256-verified by `download_models.py`; the
INT8 encoder produced by `scripts/quantize_catt.py` is deterministic for a fixed onnxruntime
version (sha256 `e6b057cf...37a0` was identical across two clean runs).

## Known remaining non-determinism

- **NSIS installer**: the compiler embeds no timestamps itself, but the uninstaller stub and
  `electron-builder` write build-time metadata; code signing (when used) adds a signing time and a
  certificate-dependent signature. Compare unsigned builds.
- **ZIP/asar members**: member timestamps follow the build clock when a tool ignores
  `SOURCE_DATE_EPOCH`; `compare_builds.py` reports "timestamp only" differences separately from
  content differences.
- **PyInstaller**: with `PYTHONHASHSEED=0` the bundle is stable, but the PE headers of the rebuilt
  bootloader (`--rebuild-bootloader`) embed the MSVC toolchain version and a link timestamp, and
  the VERSIONINFO resource contains the version only. Expect differences in the `.exe` headers.
- **Compression**: differences in the zlib/7z build on different runner images change the compressed
  size and bytes without changing contents.
- **Absolute paths** of the build directory can leak into `.pyc`/debug data; building from the
  same directory layout (as CI does) avoids it.

## Comparing two builds

```
python scripts/compare_builds.py build_a/ build_b/ --json diff.json
python scripts/compare_builds.py build_a/ build_b/ --expect-identical   # CI gate, exit 1 on any diff
```

Build twice from the same commit into two output directories (for example `desktop/dist-a` and
`desktop/dist-b`, as `update-e2e.yml` does with different versions), unpack or point the script at the
`win-unpacked` folders, and compare. The report lists files only in one tree, files whose SHA-256
differs, and for zip-like containers which members differ in content and which only in timestamp.
A build is considered reproducible when the only differing files are the installer stubs and PE headers
listed above.
