"""Resumable, crash-safe file downloads (Task 8.4.2).

Builds on `app.resources.net` (switch check, host allowlist re-checked on every redirect, SSRF-safe
connections, request log) and adds what a flaky network needs:

* HTTP Range resume. The partial file and its metadata (url, etag / last-modified, expected size
  and sha256, server-reported total) live in `<data-dir>/downloads/<key>.part|.json`, so a download
  survives connection resets *and* an application restart.
* Server support is validated, not assumed: a resume is only accepted when the server answers
  `206` with a `Content-Range` that starts exactly at our offset (and the validator still
  matches). `200` (Range ignored), a wrong range, `416`, or a changed ETag restart from zero.
* Automatic retry with exponential backoff on connection resets, timeouts, truncated bodies and
  transient HTTP errors (408/425/429/5xx), at most `MAX_RETRIES` times in a row.
* A download is never reported complete without the size AND sha256 check; a mismatch discards
  the partial (one clean restart is tried first when the bytes came from a resumed transfer).
* Cancel removes the partial and its metadata.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.core.errors import MizajError
from app.resources import net

log = logging.getLogger("mizaj.downloads")

MAX_RETRIES = 6  # consecutive failed attempts before the job is left "paused"
BACKOFF_BASE = 0.5  # seconds; doubles per failure
BACKOFF_MAX = 30.0
RETRYABLE_HTTP = frozenset({408, 425, 429, 500, 502, 503, 504})
CHUNK = 1 << 18
STATE_SAVE_EVERY = 1.0  # seconds between progress snapshots on disk
_RANGE_RE = re.compile(r"^bytes (\d+)-(\d+)/(\d+|\*)$")


class _Retry(Exception):
    """Transient failure: keep the partial file, back off, try again."""

    def __init__(self, reason: str, *, restart: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.restart = restart  # discard the partial before the next attempt


# ------------------------------------------------------------------ persisted state
def downloads_dir(data_dir: Path) -> Path:
    return Path(data_dir) / "downloads"


def safe_key(key: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", key)[:80] or "download"


def state_path(data_dir: Path, key: str) -> Path:
    return downloads_dir(data_dir) / f"{safe_key(key)}.json"


def part_path(data_dir: Path, key: str) -> Path:
    return downloads_dir(data_dir) / f"{safe_key(key)}.part"


def load_state(data_dir: Path, key: str) -> dict[str, Any] | None:
    try:
        data = json.loads(state_path(data_dir, key).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save_state(data_dir: Path, key: str, state: dict[str, Any]) -> None:
    p = state_path(data_dir, key)
    p.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def discard(data_dir: Path, key: str) -> None:
    """Remove the partial file and the metadata (cancel / hard failure)."""
    part_path(data_dir, key).unlink(missing_ok=True)
    state_path(data_dir, key).unlink(missing_ok=True)


def list_states(data_dir: Path) -> list[dict[str, Any]]:
    """All persisted (i.e. unfinished) downloads; completed ones delete their state."""
    out = []
    d = downloads_dir(data_dir)
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        try:
            st = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(st, dict) and st.get("key") and st.get("url"):
            part = part_path(data_dir, st["key"])
            st["bytes_done"] = part.stat().st_size if part.exists() else 0
            out.append(st)
    return out


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def backoff_delay(attempt: int) -> float:
    return min(BACKOFF_MAX, BACKOFF_BASE * (2 ** max(0, attempt - 1)))


def _cancelled() -> MizajError:
    return MizajError("ERR_TASK_CANCELLED", 499, "تم إلغاء التنزيل.", "Cancelled.", {})


# ------------------------------------------------------------------ the downloader
def fetch(
    url: str,
    dest: Path,
    *,
    data_dir: Path,
    key: str,
    db_path: Path,
    expected_sha256: str,
    expected_size: int | None = None,
    switch: str = "online_resources",
    progress: Callable[[int, int | None], None] | None = None,
    cancelled: Callable[[], bool] | None = None,
    on_wait: Callable[[int, float, str], None] | None = None,
    timeout: float = 30.0,
    max_bytes: int | None = None,
    max_seconds: float | None = None,
    extra: dict[str, Any] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> str:
    """Download `url` to `dest`, resuming from <data-dir>/downloads. Returns the sha256 hex.

    Raises MizajError: ERR_ONLINE_DISABLED / ERR_HOST_NOT_ALLOWED / ERR_TASK_CANCELLED (partial
    removed) / ERR_CHECKSUM_MISMATCH (partial removed) / ERR_DOWNLOAD_FAILED (non-retryable, or
    retries exhausted - then the partial and its metadata are KEPT so a later call resumes).
    """
    if not expected_sha256:
        raise ValueError("expected_sha256 is required: unverified downloads are not supported")
    net.require_switch(db_path, switch)
    net._check_url(url)
    max_bytes = net.MAX_DOWNLOAD_BYTES if max_bytes is None else max_bytes
    max_seconds = net.MAX_DOWNLOAD_SECONDS if max_seconds is None else max_seconds
    dest = Path(dest)
    part = part_path(data_dir, key)
    part.parent.mkdir(parents=True, exist_ok=True)

    st = load_state(data_dir, key)
    if st is None or st.get("url") != url or st.get("expected_sha256") != expected_sha256.lower():
        part.unlink(missing_ok=True)  # a partial of some other file/version is useless
        st = None
    if st is None and part.exists():
        part.unlink()  # no metadata: cannot prove what the bytes are
    st = st or {}
    st.update(
        {
            "key": key,
            "url": url,
            "dest": str(dest),
            "expected_sha256": expected_sha256.lower(),
            "expected_size": expected_size,
            "status": "running",
            "error": None,
            **(extra or {}),
        }
    )
    st.setdefault("etag", None)
    st.setdefault("last_modified", None)
    st.setdefault("total", None)
    st.setdefault("attempts", 0)
    st.setdefault("restarts", 0)
    save_state(data_dir, key, st)

    deadline = time.monotonic() + max_seconds
    failures = 0
    clean_retry_used = False

    def _stop_if_cancelled() -> None:
        if cancelled and cancelled():
            discard(data_dir, key)
            raise _cancelled()

    while True:
        _stop_if_cancelled()
        resumed = part.exists() and part.stat().st_size > 0
        try:
            _attempt(url, part, st, data_dir, key, progress, cancelled, timeout, max_bytes,
                     deadline, expected_size)
            digest = _verify(part, st, expected_sha256, expected_size, url)
        except _Retry as r:
            if r.restart:
                part.unlink(missing_ok=True)
                st["restarts"] += 1
            else:
                failures += 1
            st["attempts"] += 1
            st["status"] = "retrying"
            st["error"] = r.reason
            save_state(data_dir, key, st)
            if failures > MAX_RETRIES:
                st["status"] = "paused"
                save_state(data_dir, key, st)
                net._record("download", url, f"paused after {MAX_RETRIES} retries: {r.reason}")
                raise net._net_error(r.reason) from None
            if st["restarts"] > MAX_RETRIES:
                discard(data_dir, key)
                raise net._net_error("server keeps ignoring range requests: " + r.reason) from None
            delay = 0.0 if r.restart else backoff_delay(failures)
            net._record("download", url, f"retry {failures}/{MAX_RETRIES} in {delay:.1f}s: "
                                         f"{r.reason}")
            if on_wait:
                on_wait(failures, delay, r.reason)
            _wait(delay, sleep, _stop_if_cancelled)
            continue
        except _Mismatch as mm:
            part.unlink(missing_ok=True)
            if resumed and not clean_retry_used:
                # bytes of a resumed transfer may have come from a changed file: one clean retry
                clean_retry_used = True
                st["restarts"] += 1
                save_state(data_dir, key, st)
                continue
            discard(data_dir, key)
            raise net._checksum_error(mm.reason, expected_sha256, mm.actual) from None
        except MizajError as exc:
            if exc.error_code == "ERR_TASK_CANCELLED":
                discard(data_dir, key)
            elif exc.error_code in ("ERR_DOWNLOAD_FAILED", "ERR_HOST_NOT_ALLOWED"):
                # hard failure (404, size limit, blocked host): nothing worth keeping
                discard(data_dir, key)
            raise
        break

    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(part, dest)
    state_path(data_dir, key).unlink(missing_ok=True)
    net._record("download", url, "ok")
    return digest


def _wait(delay: float, sleep: Callable[[float], None], check: Callable[[], None]) -> None:
    """Sleep in slices so a cancel is honoured promptly during a long backoff."""
    end = time.monotonic() + delay
    while True:
        check()
        left = end - time.monotonic()
        if left <= 0:
            return
        sleep(min(0.2, left))


class _Mismatch(Exception):
    def __init__(self, reason: str, actual: str) -> None:
        super().__init__(reason)
        self.reason = reason
        self.actual = actual


def _verify(
    part: Path, st: dict[str, Any], sha: str, expected_size: int | None, url: str
) -> str:
    size = part.stat().st_size
    want = expected_size if expected_size is not None else st.get("total")
    digest = _sha256_file(part)
    if want is not None and size != want:
        raise _Mismatch("size mismatch", digest)
    if digest != sha.lower():
        raise _Mismatch("sha256 mismatch", digest)
    return digest


def _attempt(
    url: str,
    part: Path,
    st: dict[str, Any],
    data_dir: Path,
    key: str,
    progress: Callable[[int, int | None], None] | None,
    cancelled: Callable[[], bool] | None,
    timeout: float,
    max_bytes: int,
    deadline: float,
    expected_size: int | None,
) -> None:
    """One connection. Returns when the body is fully received (size == server total)."""
    have = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "MizajStudio/0.1 (+offline-first)", "Accept-Encoding": "identity"}
    if have:
        headers["Range"] = f"bytes={have}-"
        validator = st.get("etag") or st.get("last_modified")
        if validator:
            headers["If-Range"] = validator
    opener = urllib.request.build_opener(net._Redirect, net._SafeHTTPSHandler)
    net._record("download", url, f"start resume_from={have}")
    try:
        resp = opener.open(urllib.request.Request(url, headers=headers), timeout=timeout)
    except urllib.error.HTTPError as exc:
        code = exc.code
        exc.close()
        if code == 416 and have:
            total = st.get("total")
            if total is not None and total == have:
                return  # already have every byte; _verify decides
            raise _Retry("range not satisfiable; restarting", restart=True) from None
        if code in RETRYABLE_HTTP:
            raise _Retry(f"HTTP {code}") from None
        net._record("download", url, f"http {code}")
        raise net._net_error(f"HTTP {code}") from None
    except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
        raise _Retry(_reason(exc)) from None

    with resp:
        status = resp.status
        etag = resp.headers.get("ETag")
        last_mod = resp.headers.get("Last-Modified")
        if etag and etag.startswith("W/"):
            etag = None  # weak validators cannot guard a byte-range resume
        total: int | None
        if status == 206 and have:
            m = _RANGE_RE.match((resp.headers.get("Content-Range") or "").strip())
            if not m or int(m.group(1)) != have:
                raise _Retry("server returned a wrong/missing Content-Range", restart=True)
            total = int(m.group(3)) if m.group(3).isdigit() else None
            if st.get("etag") and etag and etag != st["etag"]:
                raise _Retry("file changed on the server", restart=True)
            mode = "ab"
        elif status in (200, 206):
            if have:  # we asked for a range but got the whole thing (no Range support)
                part.unlink(missing_ok=True)
                have = 0
            cl = resp.headers.get("Content-Length")
            try:
                total = int(cl) if cl is not None else None
            except ValueError:
                raise net._net_error("bad Content-Length") from None
            mode = "wb"
        else:
            raise _Retry(f"unexpected HTTP {status}")
        if total is not None:
            if total > max_bytes:
                raise net._net_error("file exceeds the size limit")
            if expected_size is not None and total != expected_size:
                raise _Mismatch("size mismatch", "")
        resumed = status == 206
        st.update(
            {
                "etag": (etag or st.get("etag")) if resumed else etag,
                "last_modified": (last_mod or st.get("last_modified")) if resumed else last_mod,
                "total": total,
                "status": "running",
                "error": None,
            }
        )
        save_state(data_dir, key, st)

        done = have
        last_save = time.monotonic()
        try:
            out = open(part, mode)  # noqa: SIM115 - closed in finally
        except OSError as exc:
            raise net._net_error(f"cannot write {part.name}: {exc.strerror or exc}") from None
        try:
            while True:
                try:
                    chunk = resp.read(CHUNK)
                except (OSError, http.client.HTTPException) as exc:
                    raise _Retry(_reason(exc)) from None
                if not chunk:
                    break
                if cancelled and cancelled():
                    raise _cancelled()
                try:
                    out.write(chunk)
                except OSError as exc:
                    raise net._net_error(f"cannot write: {exc.strerror or exc}") from None
                done += len(chunk)
                if done > max_bytes or time.monotonic() > deadline:
                    raise net._net_error("file exceeds the size or time limit")
                if progress:
                    progress(done, total)
                if time.monotonic() - last_save > STATE_SAVE_EVERY:
                    out.flush()
                    st["bytes_done"] = done
                    save_state(data_dir, key, st)
                    last_save = time.monotonic()
        finally:
            out.close()
    if total is not None and done < total:
        raise _Retry(f"connection closed after {done} of {total} bytes")
    if total is not None and done > total:
        raise _Retry("server sent more bytes than announced", restart=True)


def _reason(exc: BaseException) -> str:
    r = getattr(exc, "reason", None) or exc
    return f"{type(r).__name__}: {r}"[:200]
