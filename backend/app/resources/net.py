"""The ONLY module allowed to open outbound connections (AGENTS.md section 5).

* `download()` - public HTTPS downloads: requires the matching `online_*` switch, a host on the
  allowlist (re-checked on every redirect), logs every request, resumes partial files.
* `local_request()` - loopback-only JSON calls to free local tools (Ollama, LanguageTool).
"""

from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import logging
import os
import socket
import sqlite3
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.core.errors import MizajError

log = logging.getLogger("mizaj.net")

ONLINE_KEYS = ("online_resources", "online_ollama", "online_languagetool")
LOOPBACK = {"127.0.0.1", "localhost", "::1"}
ALLOWED_HOSTS: set[str] = {
    "tanzil.net",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
}
REQUEST_LOG: deque[dict[str, Any]] = deque(maxlen=200)
_lock = threading.Lock()


def allow_host(host: str) -> None:
    ALLOWED_HOSTS.add(host.lower())


def host_allowed(host: str) -> bool:
    h = (host or "").lower()
    return h in ALLOWED_HOSTS or h in LOOPBACK


def _record(kind: str, url: str, outcome: str) -> None:
    with _lock:
        REQUEST_LOG.append({"kind": kind, "url": url, "outcome": outcome})
    log.info("net %s %s -> %s", kind, url, outcome)


def get_switch(db_path: Path, key: str) -> bool:
    conn = sqlite3.connect(str(db_path), timeout=5.0)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    finally:
        conn.close()
    return bool(row) and row[0].strip().lower() == "true"


def status(db_path: Path) -> dict[str, Any]:
    return {
        "switches": {k: get_switch(db_path, k) for k in ONLINE_KEYS},
        "allowed_hosts": sorted(ALLOWED_HOSTS),
        "leaves_device": {
            "online_resources": "Only the download request for the chosen public file "
            "(URL, your IP); no document text or personal data is sent.",
            "online_ollama": "Nothing leaves the device (loopback 127.0.0.1 only).",
            "online_languagetool": "Nothing leaves the device (loopback 127.0.0.1 only).",
        },
        "recent_requests": list(REQUEST_LOG)[-20:],
    }


def disabled(key: str) -> MizajError:
    return MizajError(
        "ERR_ONLINE_DISABLED",
        403,
        "هذه الميزة معطّلة. فعّلها من الإعدادات أولاً.",
        f"This feature is off. Enable the '{key}' setting first.",
        {"setting": key},
    )


def require_switch(db_path: Path, key: str) -> None:
    if not get_switch(db_path, key):
        raise disabled(key)


def is_loopback_url(url: str) -> bool:
    try:
        p = urllib.parse.urlparse(url)
    except ValueError:
        return False
    return p.scheme in ("http", "https") and (p.hostname or "").lower() in LOOPBACK


class _Redirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        _check_url(newurl)
        _record("redirect", newurl, "follow")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


MAX_DOWNLOAD_BYTES = 2 * 1024**3
MAX_DOWNLOAD_SECONDS = 3600.0


def _blocked_address(host: str, why: str) -> MizajError:
    return MizajError(
        "ERR_HOST_NOT_ALLOWED",
        403,
        "عنوان التنزيل غير مسموح به.",
        f"Host '{host}' resolves to a {why} address.",
        {"host": host},
    )


def _addr_is_public(addr: str) -> bool:
    ip = ipaddress.ip_address(addr.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


def resolve_public(host: str, port: int = 443) -> str:
    """Resolve `host` and return one address, failing when ANY answer is private, loopback,
    link-local, multicast, reserved or otherwise non-global (SSRF / DNS-rebinding guard)."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise _net_error(f"cannot resolve {host}") from exc
    addrs = [i[4][0] for i in infos]
    if not addrs:
        raise _net_error(f"cannot resolve {host}")
    for a in addrs:
        if not _addr_is_public(a):
            _record("download", host, "blocked-private-address")
            raise _blocked_address(host, "private/loopback/link-local")
    return addrs[0]


class _SafeHTTPSConnection(http.client.HTTPSConnection):
    """Connects to the validated IP itself, so DNS cannot change between check and connect."""

    def connect(self) -> None:
        if self._tunnel_host or self.host in LOOPBACK:  # via an HTTP proxy: it does the DNS
            super().connect()
            return
        ip = resolve_public(self.host, self.port)
        sock = socket.create_connection((ip, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


class _SafeHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):  # noqa: ANN001
        return self.do_open(_SafeHTTPSConnection, req, context=ssl.create_default_context())


def _check_url(url: str) -> None:
    p = urllib.parse.urlparse(url)
    host = (p.hostname or "").lower()
    if p.scheme not in ("https", "http") or not host_allowed(host):
        _record("download", url, "blocked")
        raise MizajError(
            "ERR_HOST_NOT_ALLOWED",
            403,
            "عنوان التنزيل غير مسموح به.",
            f"Host '{host}' is not on the download allowlist.",
            {"host": host},
        )
    if p.scheme == "http" and host not in LOOPBACK:
        raise MizajError(
            "ERR_HOST_NOT_ALLOWED", 403, "يجب استخدام HTTPS.", "Plain HTTP is not allowed.", {}
        )
    if host not in LOOPBACK:
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None and not _addr_is_public(host):
            raise _blocked_address(host, "private/loopback/link-local")


def download(
    url: str,
    dest: Path,
    *,
    db_path: Path,
    switch: str = "online_resources",
    expected_sha256: str | None = None,
    expected_size: int | None = None,
    progress: Callable[[int, int | None], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
    timeout: float = 30.0,
    max_bytes: int = MAX_DOWNLOAD_BYTES,
    max_seconds: float = MAX_DOWNLOAD_SECONDS,
) -> str:
    """Download to `dest` (via dest.part, resumable). Returns the sha256 hex digest."""
    require_switch(db_path, switch)
    _check_url(url)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    have = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "MizajStudio/0.1 (+offline-first)"}
    if have:
        headers["Range"] = f"bytes={have}-"
    opener = urllib.request.build_opener(_Redirect, _SafeHTTPSHandler)
    _record("download", url, f"start resume_from={have}")
    try:
        resp = opener.open(urllib.request.Request(url, headers=headers), timeout=timeout)
    except urllib.error.HTTPError as exc:
        if exc.code == 416 and have:  # already complete
            resp = None
        else:
            _record("download", url, f"http {exc.code}")
            raise _net_error(f"HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
        _record("download", url, "error")
        raise _net_error(str(exc)) from exc
    if resp is not None:
        with resp:
            total = resp.headers.get("Content-Length")
            try:
                total_n = int(total) + (have if resp.status == 206 else 0) if total else None
            except ValueError:
                raise _net_error("bad Content-Length") from None
            if total_n is not None and total_n > max_bytes:
                raise _net_error("file exceeds the size limit")
            deadline = time.monotonic() + max_seconds
            mode = "ab" if resp.status == 206 else "wb"
            done = have if resp.status == 206 else 0
            try:
                with open(part, mode) as out:
                    while chunk := resp.read(1 << 18):
                        if cancelled and cancelled():
                            raise MizajError(
                                "ERR_TASK_CANCELLED", 499, "تم إلغاء التنزيل.", "Cancelled.", {}
                            )
                        out.write(chunk)
                        done += len(chunk)
                        if done > max_bytes or time.monotonic() > deadline:
                            part.unlink(missing_ok=True)
                            raise _net_error("file exceeds the size or time limit")
                        if progress:
                            progress(done, total_n)
            except (OSError, http.client.HTTPException) as exc:
                raise _net_error(str(exc)) from exc
    h = hashlib.sha256()
    with open(part, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    digest = h.hexdigest()
    if expected_size is not None and part.stat().st_size != expected_size:
        part.unlink(missing_ok=True)
        raise _checksum_error("size mismatch", expected_sha256, digest)
    if expected_sha256 and digest != expected_sha256.lower():
        part.unlink(missing_ok=True)
        raise _checksum_error("sha256 mismatch", expected_sha256, digest)
    os.replace(part, dest)
    _record("download", url, "ok")
    return digest


def _net_error(reason: str) -> MizajError:
    return MizajError(
        "ERR_DOWNLOAD_FAILED",
        502,
        "فشل التنزيل. أعد المحاولة لاحقاً (يُستأنف التنزيل تلقائياً).",
        f"Download failed: {reason}",
        {"reason": reason},
    )


def _checksum_error(reason: str, expected: str | None, got: str) -> MizajError:
    return MizajError(
        "ERR_CHECKSUM_MISMATCH",
        422,
        "فشل التحقق من سلامة الملف المنزَّل.",
        f"Downloaded file failed verification: {reason}",
        {"expected": expected, "actual": got},
    )


def local_request(
    base_url: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    form: dict[str, str] | None = None,
    timeout: float = 5.0,
) -> Any:
    """Loopback-only HTTP call returning parsed JSON. GET when no payload/form."""
    if not is_loopback_url(base_url):
        raise MizajError(
            "ERR_NOT_LOOPBACK",
            403,
            "يُسمح بالأدوات المحلية على الجهاز نفسه فقط.",
            "Only loopback tool URLs are allowed.",
            {"url": base_url},
        )
    p = urllib.parse.urlparse(base_url)
    conn = http.client.HTTPConnection(p.hostname, p.port or 80, timeout=timeout)
    try:
        if payload is not None:
            body = json.dumps(payload).encode()
            hdr = {"Content-Type": "application/json"}
            conn.request("POST", path, body, hdr)
        elif form is not None:
            body = urllib.parse.urlencode(form).encode()
            hdr = {"Content-Type": "application/x-www-form-urlencoded"}
            conn.request("POST", path, body, hdr)
        else:
            conn.request("GET", path)
        resp = conn.getresponse()
        data = resp.read(20_000_000)
        if resp.status >= 400:
            raise OSError(f"HTTP {resp.status}")
        return json.loads(data.decode("utf-8"))
    finally:
        conn.close()
