"""Where the Tanzil text lives, how it is obtained (verbatim) and how it is validated.

Licence (VERIFIED via several independent sources quoting the Tanzil notice; tanzil.net itself,
including tanzil.net/docs/license, is unreachable from the build environment):
  https://pypi.org/project/qran/ , https://pypi.org/project/rasm-arch/ ,
  https://www.npmjs.com/package/tanzil-downloader
Terms: CC BY 3.0 - the text may be copied and distributed VERBATIM, it must NOT be changed, and
every copy must keep the Tanzil.net attribution (with a link) and the copyright notice. Hence the
files are stored byte-for-byte as received (the notice is the trailing `#` comment block of the
`txt-2` format) and the normalized search index is built in memory only. The text is not bundled
in the installer: it is downloaded on an explicit user action (online switch `online_resources`)
or imported from a file the user fetched from https://tanzil.net/download/ .

Download protocol (from the tanzil-downloader package): HTTP POST
https://tanzil.net/pub/download/download.php, form fields quranType in {uthmani, uthmani-min,
simple, simple-enhanced, simple-min, simple-clean}, outType in {txt, txt-2}, agree=true and the
optional booleans marks, sajdah, rub, alef. `txt-2` yields `sura|aya|text` lines followed by the
`#` licence notice. No checksum can be pinned (Tanzil republishes), so files are validated
structurally instead: 6236 verse lines, the canonical verse count of each of the 114 suras,
monotonic numbering, and a notice that names Tanzil and Creative Commons.
"""

from __future__ import annotations

import hashlib
import json
import re
import urllib.parse
import urllib.request
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from app.core.errors import MizajError

ATTRIBUTION = (
    "Quran text from the Tanzil project (https://tanzil.net), licensed CC BY 3.0, "
    "used verbatim and unmodified."
)
ATTRIBUTION_AR = (
    "نص القرآن الكريم من مشروع تنزيل Tanzil.net — مرخّص بموجب CC BY 3.0 — https://tanzil.net"
)
LICENSE_URL = "https://tanzil.net/docs/text_license"
DOWNLOAD_PAGE = "https://tanzil.net/download/"
DOWNLOAD_ENDPOINT = "https://tanzil.net/pub/download/download.php"
KINDS = ("uthmani", "uthmani-min", "simple", "simple-enhanced", "simple-min", "simple-clean")
DEFAULT_KINDS = ("uthmani", "simple-clean")  # rasm used by writers + a clean one for matching
META = "meta.json"

# Canonical number of verses per sura (Hafs / Kufan count used by Tanzil); total 6236.
VERSE_COUNTS = (
    7,
    286,
    200,
    176,
    120,
    165,
    206,
    75,
    129,
    109,
    123,
    111,
    43,
    52,
    99,
    128,
    111,
    110,
    98,
    135,
    112,
    78,
    118,
    64,
    77,
    227,
    93,
    88,
    69,
    60,
    34,
    30,
    73,
    54,
    45,
    83,
    182,
    88,
    75,
    85,
    54,
    53,
    89,
    59,
    37,
    35,
    38,
    29,
    18,
    45,
    60,
    49,
    62,
    55,
    78,
    96,
    29,
    22,
    24,
    13,
    14,
    11,
    11,
    18,
    12,
    12,
    30,
    52,
    52,
    44,
    28,
    28,
    20,
    56,
    40,
    31,
    50,
    40,
    46,
    42,
    29,
    19,
    36,
    25,
    22,
    17,
    19,
    26,
    30,
    20,
    15,
    21,
    11,
    8,
    8,
    19,
    5,
    8,
    8,
    11,
    11,
    8,
    3,
    9,
    5,
    4,
    7,
    3,
    6,
    3,
    5,
    4,
    5,
    6,
)
TOTAL_VERSES = 6236
_VERSE_RE = re.compile(r"^(\d{1,3})\|(\d{1,3})\|(.+)$")


def quran_dir(data_dir: Path) -> Path:
    return Path(data_dir) / "resources" / "quran"


def _invalid(reason: str, **details) -> MizajError:
    return MizajError(
        "ERR_QURAN_INVALID",
        422,
        "ملف نص القرآن غير صالح أو معدَّل؛ استخدم الملف الأصلي من tanzil.net.",
        f"Not a valid unmodified Tanzil text file: {reason}",
        {"reason": reason, **details},
    )


def validate_tanzil_text(text: str) -> dict:
    """Structural validation of a Tanzil `txt-2` file. Returns a report or raises."""
    verses = 0
    last = (0, 0)
    per_sura = [0] * 114
    notice: list[str] = []
    for n, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        if line.startswith("#"):
            notice.append(line[1:].strip())
            continue
        m = _VERSE_RE.match(line)
        if not m:
            raise _invalid("unexpected line", line=n)
        sura, aya = int(m.group(1)), int(m.group(2))
        if not 1 <= sura <= 114:
            raise _invalid("sura out of range", line=n, sura=sura)
        expected = (sura, aya)
        if not ((sura == last[0] and aya == last[1] + 1) or (sura == last[0] + 1 and aya == 1)):
            raise _invalid("verse numbering not monotonic", line=n, got=expected, after=last)
        last = expected
        per_sura[sura - 1] += 1
        verses += 1
    if verses != TOTAL_VERSES:
        raise _invalid("wrong verse count", expected=TOTAL_VERSES, got=verses)
    for i, (got, want) in enumerate(zip(per_sura, VERSE_COUNTS, strict=True), 1):
        if got != want:
            raise _invalid("wrong verse count in sura", sura=i, expected=want, got=got)
    joined = " ".join(notice)
    if "Tanzil" not in joined or "Creative Commons" not in joined:
        raise _invalid("licence notice (Tanzil / Creative Commons) missing")
    return {"verses": verses, "suras": 114, "notice": "\n".join(notice)}


def _sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def _meta(d: Path) -> dict:
    try:
        return json.loads((d / META).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def installed_files(data_dir: Path) -> dict[str, Path]:
    d = quran_dir(data_dir)
    return {k: d / f"quran-{k}.txt" for k in KINDS if (d / f"quran-{k}.txt").is_file()}


def ensure_quran_text(data_dir: Path) -> dict[str, Path]:
    """Return the installed text files (kind -> path); never touches the network."""
    return installed_files(data_dir)


def _store(
    data_dir: Path, kind: str, raw: bytes, *, validate: bool, source_url: str, extra: dict
) -> Path:
    if kind not in KINDS:
        raise MizajError("ERR_VALIDATION", 422, "نوع غير صالح.", f"kind must be one of {KINDS}")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _invalid("file is not UTF-8") from exc
    report = validate_tanzil_text(text) if validate else {"notice": ""}
    d = quran_dir(data_dir)
    d.mkdir(parents=True, exist_ok=True)
    dest = d / f"quran-{kind}.txt"
    tmp = dest.with_suffix(".tmp")
    tmp.write_bytes(raw)  # byte-for-byte: the licence forbids changing the text
    tmp.replace(dest)
    meta = _meta(d)
    meta[kind] = {
        "sha256": _sha256_bytes(raw),
        "bytes": len(raw),
        "downloaded_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source_url": source_url,
        "type": kind,
        "notice": report["notice"],
        "attribution": ATTRIBUTION,
        "license": "CC BY 3.0",
        "license_url": LICENSE_URL,
        **extra,
    }
    (d / META).write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    return dest


def install_quran_text(
    data_dir: Path,
    source: Path,
    kind: str,
    expected_sha256: str | None = None,
    *,
    validate: bool = True,
) -> Path:
    """Manual install of a file the user got from tanzil.net (validated, stored verbatim).

    `validate=False` exists for tests with tiny synthetic fixtures; the API always validates.
    """
    source = Path(source)
    if not source.is_file():
        raise MizajError(
            "ERR_QURAN_SOURCE_MISSING",
            404,
            "ملف النص غير موجود.",
            "Quran source file not found.",
            {"path": str(source)},
        )
    raw = source.read_bytes()
    if expected_sha256 and _sha256_bytes(raw) != expected_sha256.lower():
        raise MizajError(
            "ERR_QURAN_CHECKSUM",
            422,
            "فشل التحقق من بصمة الملف.",
            "SHA-256 mismatch.",
            {"expected": expected_sha256, "actual": _sha256_bytes(raw)},
        )
    return _store(
        data_dir,
        kind,
        raw,
        validate=validate,
        source_url=DOWNLOAD_PAGE,
        extra={"imported_from": source.name},
    )


def _form_fields(kind: str) -> dict[str, str]:
    f = {"quranType": kind, "outType": "txt-2", "agree": "true"}
    if kind == "uthmani":  # keep Uthmani signs: marks, sajdah, rub el hizb, alef
        f.update({"marks": "true", "sajdah": "true", "rub": "true", "alef": "true"})
    return f


def _default_post(url: str, fields: dict[str, str]) -> bytes:
    from app.resources import net  # the only module allowed to reach the network

    p = urllib.parse.urlparse(url)
    if not net.host_allowed((p.hostname or "").lower()) or p.hostname != "tanzil.net":
        raise MizajError(
            "ERR_HOST_NOT_ALLOWED",
            403,
            "عنوان التنزيل غير مسموح به.",
            "Host not allowed.",
            {"host": p.hostname},
        )

    class _NoOffsiteRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
            if urllib.parse.urlparse(newurl).hostname != "tanzil.net":
                raise MizajError(
                    "ERR_HOST_NOT_ALLOWED",
                    403,
                    "إعادة توجيه غير مسموحة.",
                    "Redirect blocked.",
                    {"url": newurl},
                )
            return super().redirect_request(req, fp, code, msg, headers, newurl)

    req = urllib.request.Request(
        url,
        data=urllib.parse.urlencode(fields).encode(),
        headers={
            "User-Agent": "MizajStudio/0.1 (+offline-first)",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.build_opener(_NoOffsiteRedirect).open(req, timeout=60) as r:
            return r.read(40_000_000)
    except OSError as exc:
        raise MizajError(
            "ERR_QURAN_DOWNLOAD",
            502,
            "تعذر تنزيل النص.",
            "Quran download failed.",
            {"reason": str(exc)},
        ) from exc


def download_quran_text(
    data_dir: Path,
    db_path: Path,
    kinds: tuple[str, ...] = DEFAULT_KINDS,
    *,
    post: Callable[[str, dict[str, str]], bytes] | None = None,
) -> dict[str, Path]:
    """Opt-in download from tanzil.net. Requires the `online_resources` switch.

    Everything is validated before anything is written, so a failed/altered download leaves the
    previous installation untouched. Only tanzil.net is contacted; nothing about the user's
    documents is sent (just the form fields above).
    """
    from app.resources import net

    net.require_switch(db_path, "online_resources")
    do_post = post or _default_post
    got: dict[str, bytes] = {}
    for kind in kinds:
        if kind not in KINDS:
            raise MizajError("ERR_VALIDATION", 422, "نوع غير صالح.", f"unknown kind {kind}")
        raw = do_post(DOWNLOAD_ENDPOINT, _form_fields(kind))
        try:
            validate_tanzil_text(raw.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise _invalid("file is not UTF-8") from exc
        got[kind] = raw
    out: dict[str, Path] = {}
    for kind, raw in got.items():
        out[kind] = _store(
            data_dir,
            kind,
            raw,
            validate=True,
            source_url=DOWNLOAD_ENDPOINT,
            extra={"form": _form_fields(kind)},
        )
    return out


def status(data_dir: Path) -> dict:
    files = installed_files(data_dir)
    meta = _meta(quran_dir(data_dir))
    return {
        "installed": bool(files),
        "texts": {k: {"path": str(p), **meta.get(k, {})} for k, p in files.items()},
        "attribution": ATTRIBUTION,
        "attribution_ar": ATTRIBUTION_AR,
        "license": "CC BY 3.0",
        "license_url": LICENSE_URL,
        "download_page": DOWNLOAD_PAGE,
        "download_endpoint": DOWNLOAD_ENDPOINT,
        "download_kinds": list(DEFAULT_KINDS),
    }
