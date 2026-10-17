# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Mizaj sidecar (one-folder build named `mizaj-engine`).
# Build with: python scripts/build_backend.py
#
# Reality vs. the original plan: libtashkeel does not exist on PyPI (not bundled; fast mode is
# mishkal); the CATT model is NOT baked in (resolved at runtime: $MIZAJ_MODELS_DIR,
# <data-dir>/models/catt_eo, <exe dir>/models/catt_eo, backend/models/catt_eo).
import os

from PyInstaller.utils.hooks import (
    collect_all,
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
)

BACKEND = os.path.abspath(SPECPATH)  # noqa: F821  (SPECPATH is injected by PyInstaller)

datas, binaries, hiddenimports = [], [], []

# Arabic NLP stack: pure-python packages whose sqlite dictionaries / pickles are data files.
for pkg in (
    "mishkal", "qalsadi", "tashaphyne", "arramooz", "pyarabic", "naftawayh", "alyahmor",
    "libqutrub", "asmai", "maskouk", "mysam", "arabicstopwords", "sylajone", "codernitydb3",
    "hijridate",
):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

datas += collect_data_files("docx")  # python-docx default template, styles, etc.
binaries += collect_dynamic_libs("onnxruntime")
hiddenimports += [
    "onnxruntime.capi._pybind_state",
    "onnxruntime.capi.onnxruntime_pybind11_state",
    "lxml._elementpath",
    "lxml.etree",
    "pickledb",
]
hiddenimports += collect_submodules("uvicorn") + ["uvicorn.logging", "uvicorn.loops.auto",
                                                   "uvicorn.protocols.http.auto"]
hiddenimports += collect_submodules("app")

# our own resources
datas += [
    (os.path.join(BACKEND, "app", "migrations"), os.path.join("app", "migrations")),
    (os.path.join(BACKEND, "app", "legal", "data"), os.path.join("app", "legal", "data")),
    (os.path.join(BACKEND, "app", "engine", "catt", "NOTICE"), os.path.join("app", "engine", "catt")),
    # 7.9 spelling: ayaspell Hunspell dictionary (ar.aff, ar.dic.gz), confusables.json, licences
    (os.path.join(BACKEND, "app", "spelling", "data"), os.path.join("app", "spelling", "data")),
]

# --- size trimming: drop test suites and dev-only data shipped inside packages ---
def _keep(entry):
    dest = entry[1].replace("\\", "/")
    src = entry[0].replace("\\", "/")
    for bad in ("/tests/", "/test/", "/__pycache__/"):
        if bad in dest + "/" or bad in src:
            return False
    return not src.endswith((".pyi", ".md", ".rst", ".pyc"))

datas = [d for d in datas if _keep(d)]
# maskouk (collocation database, 22 MB) is imported by mishkal but never queried by the
# tashkeel / qalsadi paths we use (verified with the frozen build: fast, accurate, suggestions).
datas = [d for d in datas if not d[1].replace("\\", "/").startswith("maskouk/data")]

# arramooz / asmai / qalsadi contain a py2exe-style branch: when `sys.frozen` is set they open
# their sqlite dictionaries at <sys.prefix>/data/<name>.sqlite (sys.prefix == the _internal dir
# under PyInstaller). Ship those files there (single copy) instead of inside the packages.
_DATA_PKGS = ("arramooz/data", "asmai/data", "qalsadi/data")


def _relocate(entry):
    src, dest = entry[0], entry[1].replace("\\", "/")
    if dest in _DATA_PKGS and src.endswith(".sqlite"):
        return (src, "data")
    return entry


datas = [_relocate(d) for d in datas]

excludes = [
    "tkinter", "matplotlib", "IPython", "pytest", "ruff", "pip", "setuptools", "wheel",
    "pkg_resources", "distutils", "jaraco",
    "sympy", "mpmath",          # only used by onnxruntime's offline tooling, not by inference
    "onnxruntime.tools", "onnxruntime.transformers", "onnxruntime.quantization",
    "onnxruntime.datasets", "onnxruntime.backend",
    "PyInstaller", "docx.tests", "numpy.tests", "numpy.f2py", "numpy.distutils",
]

a = Analysis(  # noqa: F821
    [os.path.join(BACKEND, "engine_entry.py")],
    pathex=[BACKEND],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="mizaj-engine",   # mizaj-engine.exe on Windows
    debug=False,
    strip=False,
    upx=False,
    console=True,          # stdout carries the MIZAJ_PORT handshake; Electron hides the window
)
coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="mizaj-engine",
)
