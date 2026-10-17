# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the Mizaj sidecar (one-folder build named `mizaj-engine`).
# Build with: python scripts/build_backend.py
#
# Reality vs. the original plan: libtashkeel does not exist on PyPI (not bundled; fast mode is
# mishkal); the CATT model is NOT baked in (resolved at runtime: $MIZAJ_MODELS_DIR,
# <data-dir>/models/catt_eo, <exe dir>/models/catt_eo, backend/models/catt_eo).
import json
import os
import re
import sys

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
    # 7.1 engine data (minimal-level rules, proper nouns) and 7.8 free-resource catalog
    (os.path.join(BACKEND, "app", "engine", "data"), os.path.join("app", "engine", "data")),
    (os.path.join(BACKEND, "app", "resources", "catalog.json"), os.path.join("app", "resources")),
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

# --- 8.3.3 size: things that are shipped but never used at runtime ---
# 1. collect_all() also copies every package's .py SOURCE as data (25 MB: stopword tables etc.);
#    the same modules are already in the PYZ as bytecode and nothing reads the .py files.
datas = [d for d in datas if not d[0].endswith(".py")]
# 2./3. (pdfminer CJK CMaps, unused lxml parts) are added by PyInstaller hooks during Analysis,
#    so they are filtered from a.datas below.

# Native libraries of optional Pillow/lxml codecs that no feature of Mizaj uses (AVIF 5 MB, lcms,
# Tk bridge; objectify/sax/builder are lxml extras). _imaging/_webp/_imagingft keep their libs.
_DROP_BINARIES = (
    "PIL/_avif", "libavif", "PIL/_imagingtk", "PIL/_imagingcms", "liblcms2",
    "lxml/objectify", "lxml/sax", "lxml/builder",
)


def _keep_binary(entry):
    name = (entry[0] + "|" + entry[1]).replace("\\", "/")
    return not any(x in name for x in _DROP_BINARIES)

excludes = [
    "tkinter", "matplotlib", "IPython", "pytest", "ruff", "pip", "setuptools", "wheel",
    "pkg_resources", "distutils", "jaraco",
    "sympy", "mpmath",          # only used by onnxruntime's offline tooling, not by inference
    "onnxruntime.tools", "onnxruntime.transformers", "onnxruntime.quantization",
    "onnxruntime.datasets", "onnxruntime.backend",
    "PyInstaller", "docx.tests", "numpy.tests", "numpy.f2py", "numpy.distutils",
    "PIL._avif", "PIL._imagingtk", "PIL._imagingcms", "PIL.ImageTk", "PIL.ImageCms",
    "lxml.objectify", "lxml.html", "lxml.isoschematron", "lxml.sax", "lxml.builder",
    "lxml.cssselect",
]

# --- Windows VERSIONINFO resource for mizaj-engine.exe (reduces AV "unknown binary" heuristics) ---
def _app_version():
    v = os.environ.get("MIZAJ_VERSION", "").strip().lstrip("v")
    if not v:
        try:
            with open(os.path.join(BACKEND, "..", "desktop", "package.json"), encoding="utf-8") as f:
                v = json.load(f).get("version", "")
        except OSError:
            v = ""
    return v or "0.0.0"


def _write_version_file():
    """Write a PyInstaller version file (Windows only); returns its path or None."""
    if sys.platform != "win32":
        return None
    ver = _app_version()
    nums = [int(x) for x in re.findall(r"\d+", ver.split("-")[0].split("+")[0])[:4]]
    nums += [0] * (4 - len(nums))
    tup = tuple(nums)
    text = f"""VSVersionInfo(
  ffi=FixedFileInfo(filevers={tup}, prodvers={tup}, mask=0x3f, flags=0x0, OS=0x40004,
                    fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('040904B0', [
      StringStruct('CompanyName', 'Mizaj Studio'),
      StringStruct('FileDescription', 'Mizaj Studio engine'),
      StringStruct('FileVersion', {ver!r}),
      StringStruct('InternalName', 'mizaj-engine'),
      StringStruct('LegalCopyright', 'GPL-3.0-or-later'),
      StringStruct('OriginalFilename', 'mizaj-engine.exe'),
      StringStruct('ProductName', 'Mizaj Studio'),
      StringStruct('ProductVersion', {ver!r})])]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ])
"""
    path = os.path.join(BACKEND, "build", "mizaj_engine_version.txt")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    return path


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
a.binaries = [b for b in a.binaries if _keep_binary(b)]
# (pdfminer's CJK CMaps are deliberately KEPT: a PDF naming one would otherwise fail to import.)
# lxml: only lxml.etree is used (python-docx, our XML code); html/isoschematron are never imported.
_DROP_DATA = ("lxml/html/", "lxml/isoschematron/", "lxml/includes/")
a.datas = [d for d in a.datas if not d[0].replace("\\", "/").startswith(_DROP_DATA)]
pyz = PYZ(a.pure)  # noqa: F821
exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="mizaj-engine",   # mizaj-engine.exe on Windows
    debug=False,
    strip=False,
    upx=False,             # never UPX: packed binaries are a classic AV trigger
    console=True,          # stdout carries the MIZAJ_PORT handshake; Electron hides the window
    version=_write_version_file(),
)
coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="mizaj-engine",
)
