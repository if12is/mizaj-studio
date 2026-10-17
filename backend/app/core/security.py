"""Security primitives for the local sidecar (Phase 8, Slice 8.1).

* `SecurityMiddleware`: per-launch API token (8.1.1), Host-header allowlist against DNS
  rebinding (8.1.2) and a request-body size cap (DoS).
* `safe_path`: the single validator for every user-supplied file path (8.1.3).
* `check_zip` / `reject_xml_dtd`: zip-bomb and XML-entity guards for DOCX / EPUB / packs / backups
  (8.1.4).

Nothing here ever logs a header value or a document text.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import stat
import zipfile
from collections.abc import Iterable
from pathlib import Path

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.errors import MizajError, validation_error

log = logging.getLogger("mizaj.security")

TOKEN_HEADER = "x-mizaj-token"
TOKEN_ENV = "MIZAJ_API_TOKEN"
PUBLIC_PATHS = {("GET", "/health")}
MAX_BODY_BYTES = 64 * 1024 * 1024  # 5M chars of Arabic JSON-escaped is ~30 MB
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}

_warned_no_token = False


# --------------------------------------------------------------------------- errors
def unauthorized() -> MizajError:
    return MizajError(
        "ERR_UNAUTHORIZED", 401, "غير مصرّح بالوصول.", "Missing or invalid API token.", {}
    )


def host_not_allowed() -> MizajError:
    return MizajError(
        "ERR_HOST_NOT_ALLOWED",
        421,
        "المضيف غير مسموح به.",
        "Host header must be 127.0.0.1 or localhost.",
        {},
    )


def payload_too_large() -> MizajError:
    return MizajError(
        "ERR_PAYLOAD_TOO_LARGE", 413, "حجم الطلب كبير جداً.", "Request body is too large.", {}
    )


def file_too_large(limit: int) -> MizajError:
    return MizajError(
        "ERR_FILE_TOO_LARGE",
        413,
        "حجم الملف كبير جداً.",
        f"File is larger than the {limit // (1024 * 1024)} MiB limit.",
        {"limit_bytes": limit},
    )


def warn_if_no_token() -> None:
    """Log (once per process) that the API is open because no token was configured."""
    global _warned_no_token
    if not _warned_no_token:
        _warned_no_token = True
        log.warning("MIZAJ_API_TOKEN is not set: API authentication is DISABLED (dev/test only)")


# --------------------------------------------------------------------------- middleware
def host_ok(host_header: str | None, *, allow_testserver: bool = False) -> bool:
    """True when the Host header names the loopback interface (any port)."""
    if not host_header:
        return False
    h = host_header.strip().lower()
    if h.startswith("["):  # [::1]:port
        name = h.split("]", 1)[0] + "]"
    else:
        name = h.rsplit(":", 1)[0] if ":" in h else h
    if name in LOOPBACK_HOSTS:
        return True
    return allow_testserver and name == "testserver"


def _json_response(err: MizajError) -> tuple[Message, Message]:
    body = json.dumps(err.envelope(), ensure_ascii=False).encode("utf-8")
    start = {
        "type": "http.response.start",
        "status": err.status,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode()),
        ],
    }
    return start, {"type": "http.response.body", "body": body}


class _BodyTooLarge(BaseException):  # noqa: N818
    """BaseException on purpose: FastAPI turns any Exception raised while reading the body into
    a 400, which would hide the 413."""


class SecurityMiddleware:
    """Pure ASGI (does not buffer, so SSE streams keep working)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        state = scope["app"].state if "app" in scope else None
        token: str | None = getattr(state, "api_token", None)
        if scope["type"] != "http":  # no websockets are served
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        if not host_ok(headers.get("host"), allow_testserver=not token):
            await self._reply(send, host_not_allowed())
            return
        authorized = True
        if token:
            given = headers.get(TOKEN_HEADER, "")
            authorized = hmac.compare_digest(given.encode("utf-8"), token.encode("utf-8"))
            if not authorized and (scope["method"], scope["path"]) not in PUBLIC_PATHS:
                await self._reply(send, unauthorized())
                return
        scope.setdefault("state", {})["authorized"] = authorized
        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
            await self._reply(send, payload_too_large())
            return
        seen = 0
        started = False

        async def counted_receive() -> Message:
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > MAX_BODY_BYTES:
                    raise _BodyTooLarge
            return msg

        async def tracked_send(msg: Message) -> None:
            nonlocal started
            if msg["type"] == "http.response.start":
                started = True
            await send(msg)

        try:
            await self.app(scope, counted_receive, tracked_send)
        except _BodyTooLarge:
            if not started:
                await self._reply(send, payload_too_large())

    @staticmethod
    async def _reply(send: Send, err: MizajError) -> None:
        start, body = _json_response(err)
        await send(start)
        await send(body)


# --------------------------------------------------------------------------- paths
_RESERVED = {
    "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
    "COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
}  # fmt: skip
_DRIVE = re.compile(r"^[A-Za-z]:$")
MAX_PATH_CHARS = 4096
MB = 1024 * 1024


def _syntax_check(raw: object, field: str) -> str:
    def bad(reason: str):
        return validation_error(f"{field}: {reason}", {"field": field, "reason": reason})

    if not isinstance(raw, str) or not raw.strip():
        raise bad("a path is required")
    if "\x00" in raw or len(raw) > MAX_PATH_CHARS:
        raise bad("invalid path")
    norm = raw.replace("/", "\\")
    if norm.startswith("\\\\"):
        raise bad("network (UNC) and device paths are not allowed")
    comps = [c for c in norm.split("\\") if c]
    for i, c in enumerate(comps):
        if c == "..":
            raise bad("'..' is not allowed")
        if ":" in c and not (i == 0 and _DRIVE.match(c)):
            raise bad("alternate data streams / device syntax are not allowed")
        stem = c.rstrip(". ").split(".", 1)[0].rstrip(" ").upper()
        if stem in _RESERVED:
            raise bad("reserved device names are not allowed")
    if not Path(raw).is_absolute():
        raise bad("must be an absolute path")
    return raw


def _within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _real(p: Path) -> Path:
    return Path(os.path.realpath(p))


def _is_unc(p: Path) -> bool:
    """True for network paths after resolution (`\\\\host\\share`, `\\\\?\\UNC\\...`). The
    extended-length prefix of a *local* drive (`\\\\?\\C:\\...`, which realpath may keep on long
    paths) is not a network path."""
    s = str(p).replace("/", "\\")
    if s.startswith("\\\\?\\") and not s.upper().startswith("\\\\?\\UNC\\"):
        return False
    return s.startswith("\\\\")


def safe_path(
    raw: object,
    field: str,
    *,
    exts: Iterable[str] | None = None,
    kind: str = "input",
    data_dir: Path | None = None,
    max_bytes: int | None = None,
    avoid: Path | None = None,
) -> Path:
    """Validate a user-supplied file path and return its resolved form.

    kind="input": must be an existing regular file (404 otherwise), at most `max_bytes`.
    kind="output": parent must be an existing directory outside `data_dir`; the target must not be
    a symlink, a special file, or the same file as `avoid` (the source).
    """
    from app.core.errors import not_found

    s = _syntax_check(raw, field)
    p = Path(s)
    resolved = _real(p)
    if _is_unc(resolved):
        raise validation_error(
            f"{field}: network (UNC) paths are not allowed", {"field": field}
        )
    if exts is not None:
        allowed = {e.lower() for e in exts}
        if p.suffix.lower() not in allowed:
            raise validation_error(
                f"{field} must end with one of: {', '.join(sorted(allowed)) or 'none'}",
                {"field": field, "allowed": sorted(allowed)},
            )
    st = None
    if kind == "input":
        try:
            st = os.stat(resolved)
        except OSError:
            raise not_found("File", s) from None
    if st is not None:
        if not stat.S_ISREG(st.st_mode):
            raise validation_error(f"{field} must be a regular file", {"field": field})
        if max_bytes is not None and st.st_size > max_bytes:
            raise file_too_large(max_bytes)
        return resolved
    parent = resolved.parent
    if not parent.is_dir():
        raise validation_error("target directory does not exist", {"field": field})
    if os.path.islink(p):
        raise validation_error(f"{field}: symbolic links are not allowed", {"field": field})
    if data_dir is not None and _within(parent, _real(Path(data_dir))):
        raise validation_error(
            f"{field}: writing into the application data folder is not allowed", {"field": field}
        )
    if resolved.exists() and not stat.S_ISREG(os.stat(resolved).st_mode):
        raise validation_error(f"{field} must be a regular file", {"field": field})
    if avoid is not None and resolved == _real(Path(avoid)):
        raise validation_error(f"{field} must differ from the source file", {"field": field})
    return resolved


def safe_dir(
    raw: object, field: str, *, kind: str = "input", data_dir: Path | None = None
) -> Path:
    """Directory variant of `safe_path` (batch folders)."""
    from app.core.errors import not_found

    s = _syntax_check(raw, field)
    resolved = _real(Path(s))
    if _is_unc(resolved):
        raise validation_error(
            f"{field}: network (UNC) paths are not allowed", {"field": field}
        )
    if kind == "input":
        if not resolved.exists():
            raise not_found("Directory", s)
        if not resolved.is_dir():
            raise validation_error(f"{field} does not exist", {"field": field})
    else:
        if resolved.exists() and not resolved.is_dir():
            raise validation_error(f"{field} must be a directory", {"field": field})
        if data_dir is not None:
            dd = _real(Path(data_dir))
            if _within(resolved, dd):
                raise validation_error(
                    f"{field}: writing into the application data folder is not allowed",
                    {"field": field},
                )
    return resolved


# --------------------------------------------------------------------------- zip / xml
def check_zip(
    zf: zipfile.ZipFile,
    *,
    max_members: int = 20_000,
    max_total: int = 2 * 1024**3,
    max_member: int = 1024**3,
    max_ratio: int = 200,
    ratio_floor: int = 1 << 20,
    error=None,
) -> None:
    """Reject zip bombs from the central directory alone (nothing is decompressed).

    `error(reason)` must return the exception to raise (defaults to a validation error).
    """
    mk = error or (lambda r: validation_error(f"archive rejected: {r}", {"reason": r}))
    infos = zf.infolist()
    if len(infos) > max_members:
        raise mk("too many members")
    total = 0
    for i in infos:
        total += i.file_size
        if i.file_size > max_member:
            raise mk("member too large")
        if i.file_size > ratio_floor and (
            i.compress_size == 0 or i.file_size / i.compress_size > max_ratio
        ):
            raise mk("suspicious compression ratio")
    if total > max_total:
        raise mk("archive expands to too much data")


_DTD_MARKERS = tuple(
    m.encode(enc)
    for m in ("<!DOCTYPE", "<!ENTITY")
    for enc in ("ascii", "utf-16-le", "utf-16-be")
)


def has_xml_declaration(data: bytes, markers: tuple[bytes, ...] = _DTD_MARKERS) -> bool:
    """True when the (head of the) XML document contains a DOCTYPE/ENTITY declaration."""
    head = data[:65536]
    low = head.upper()
    return any(m.upper() in low for m in markers)


ENTITY_MARKERS = tuple(m for m in _DTD_MARKERS if b"ENTITY" in m.upper())


def hardened_xml_parser(**kw):
    """lxml parser with every dangerous feature off (no entities, DTD, network, huge trees)."""
    from lxml import etree

    return etree.XMLParser(
        resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False,
        dtd_validation=False, attribute_defaults=False, **kw,
    )  # fmt: skip


def harden_docx_parser() -> None:
    """Replace python-docx's module-level parser with an explicitly hardened one that keeps its
    custom element classes. Idempotent."""
    import docx.oxml.parser as dp

    if getattr(dp, "_mizaj_hardened", False):
        return
    parser = hardened_xml_parser(remove_blank_text=True)
    parser.set_element_class_lookup(dp.element_class_lookup)
    dp.oxml_parser = parser
    dp._mizaj_hardened = True
