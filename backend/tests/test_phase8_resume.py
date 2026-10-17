"""Task 8.4.2 / 8.4.3: resumable downloads, SSE resume from the chunk cache, batch resume."""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from io_helpers import build_client, set_setting

from app.core.errors import MizajError
from app.io import batch
from app.resources import downloads, manager

BACKEND = Path(__file__).resolve().parent.parent
BLOB = bytes((i * 31 + 7) % 251 for i in range(600_000))
SHA = hashlib.sha256(BLOB).hexdigest()


# ---------------------------------------------------------------- flaky Range server
class Flaky(BaseHTTPRequestHandler):
    drops: list[int] = []  # per connection: cut the body after N bytes (consumed in order)
    range_mode = "ok"  # ok | none (ignores Range) | nocr (206 without Content-Range)
    etag = '"v1"'
    requests: list[dict] = []
    lock = threading.Lock()

    def do_GET(self):  # noqa: N802
        rng = self.headers.get("Range")
        with Flaky.lock:
            Flaky.requests.append({"range": rng, "if_range": self.headers.get("If-Range")})
            drop = Flaky.drops.pop(0) if Flaky.drops else None
        if self.path == "/missing":
            self.send_response(404)
            self.end_headers()
            return
        start = 0
        status = 200
        if rng and Flaky.range_mode != "none":
            start = int(rng.split("=")[1].split("-")[0])
            if start >= len(BLOB):
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{len(BLOB)}")
                self.end_headers()
                return
            status = 206
        body = BLOB[start:]
        self.send_response(status)
        self.send_header("ETag", Flaky.etag)
        self.send_header("Content-Length", str(len(body)))
        if status == 206 and Flaky.range_mode == "ok":
            self.send_header("Content-Range", f"bytes {start}-{len(BLOB) - 1}/{len(BLOB)}")
        self.end_headers()
        try:
            if drop is not None and drop < len(body):
                self.wfile.write(body[:drop])
                self.wfile.flush()
                self.connection.shutdown(2)  # connection dies mid-transfer
                return
            self.wfile.write(body)
        except OSError:
            pass

    def log_message(self, *a):
        pass


@pytest.fixture
def flaky(monkeypatch):
    Flaky.drops, Flaky.range_mode, Flaky.etag, Flaky.requests = [], "ok", '"v1"', []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Flaky)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setattr(downloads, "BACKOFF_BASE", 0.0)
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    manager.set_catalog(None)


def entry(url, **kw):
    return {
        "id": "t1", "name": "T", "kind": "corpus", "url": url + "/file.bin", "filename": "file.bin",
        "sha256": SHA, "size": len(BLOB), "license": "CC0", "license_url": "http://x",
        "attribution": "me", **kw,
    }  # fmt: skip


def fetch(ioc, url, **kw):
    kw.setdefault("expected_sha256", SHA)
    kw.setdefault("expected_size", len(BLOB))
    return downloads.fetch(
        url + "/file.bin", ioc.data_dir / "out" / "file.bin", data_dir=ioc.data_dir, key="k1",
        db_path=ioc.data_dir / "mizaj.db", **kw,
    )


@pytest.fixture
def ioc(data_dir):
    with build_client(data_dir) as c:
        c.data_dir = data_dir
        set_setting(c, online_resources="true")
        yield c


# ---------------------------------------------------------------- 8.4.2
def test_resumes_with_range_after_repeated_connection_drops(ioc, flaky):
    Flaky.drops = [100_000, 150_000, 1, 200_000]
    digest = fetch(ioc, flaky)
    assert digest == SHA and (ioc.data_dir / "out" / "file.bin").read_bytes() == BLOB
    ranges = [r["range"] for r in Flaky.requests]
    assert len(ranges) == 5 and ranges[0] is None and all(r for r in ranges[1:])
    # later requests continue at the cumulative offset (never re-download from byte 0)
    offs = [int(r.split("=")[1].rstrip("-")) for r in ranges[1:]]
    assert offs == sorted(offs) and offs[0] == 100_000
    assert Flaky.requests[1]["if_range"] == '"v1"'
    assert not list((ioc.data_dir / "downloads").glob("*"))  # state + partial removed


def test_server_without_range_support_restarts_from_zero(ioc, flaky):
    Flaky.range_mode = "none"
    Flaky.drops = [250_000, 300_000]
    assert fetch(ioc, flaky) == SHA
    assert (ioc.data_dir / "out" / "file.bin").read_bytes() == BLOB


def test_206_without_content_range_is_not_trusted(ioc, flaky):
    Flaky.range_mode = "nocr"
    Flaky.drops = [200_000]
    assert fetch(ioc, flaky) == SHA  # restart after the bad 206, then a clean full 200/206
    assert (ioc.data_dir / "out" / "file.bin").read_bytes() == BLOB


def test_changed_etag_restarts(ioc, flaky):
    Flaky.drops = [100_000]
    seen = []

    def prog(done, total):
        seen.append(done)
        if len(seen) == 1:
            Flaky.etag = '"v2"'  # the file changes while we are interrupted

    assert fetch(ioc, flaky, progress=prog) == SHA
    assert (ioc.data_dir / "out" / "file.bin").read_bytes() == BLOB


def test_never_complete_without_checksum_and_partial_cleaned(ioc, flaky):
    with pytest.raises(MizajError) as e:
        fetch(ioc, flaky, expected_sha256="0" * 64)
    assert e.value.error_code == "ERR_CHECKSUM_MISMATCH"
    assert not (ioc.data_dir / "out" / "file.bin").exists()
    assert not list((ioc.data_dir / "downloads").glob("*"))
    with pytest.raises(MizajError) as e:  # wrong size
        fetch(ioc, flaky, expected_size=len(BLOB) + 1)
    assert e.value.error_code == "ERR_CHECKSUM_MISMATCH"
    assert not (ioc.data_dir / "out" / "file.bin").exists()


def test_retries_exhausted_keeps_partial_then_resumes(ioc, flaky, monkeypatch):
    monkeypatch.setattr(downloads, "MAX_RETRIES", 2)
    Flaky.drops = [100_000, 20_000, 20_000]  # 3 consecutive failures > 2 retries
    with pytest.raises(MizajError) as e:
        fetch(ioc, flaky)
    assert e.value.error_code == "ERR_DOWNLOAD_FAILED"
    st = downloads.load_state(ioc.data_dir, "k1")
    part = downloads.part_path(ioc.data_dir, "k1")
    assert st["status"] == "paused" and part.exists() and part.stat().st_size >= 100_000
    kept = part.stat().st_size
    Flaky.requests.clear()
    assert fetch(ioc, flaky) == SHA  # a later call continues from the kept bytes
    assert Flaky.requests[0]["range"] == f"bytes={kept}-"


def test_http_404_is_not_retried(ioc, flaky):
    with pytest.raises(MizajError) as e:
        downloads.fetch(
            flaky + "/missing", ioc.data_dir / "x", data_dir=ioc.data_dir, key="k2",
            db_path=ioc.data_dir / "mizaj.db", expected_sha256=SHA,
        )
    assert e.value.error_code == "ERR_DOWNLOAD_FAILED" and len(Flaky.requests) == 1


def test_cancel_removes_partial(ioc, flaky):
    Flaky.drops = [100_000]
    n = []

    def cancelled():
        n.append(1)
        return len(n) > 3

    with pytest.raises(MizajError) as e:
        fetch(ioc, flaky, cancelled=cancelled)
    assert e.value.error_code == "ERR_TASK_CANCELLED"
    assert not list((ioc.data_dir / "downloads").glob("*"))


def test_job_survives_restart_listed_paused_and_resumes(data_dir, flaky, monkeypatch):
    monkeypatch.setattr(downloads, "MAX_RETRIES", 0)
    manager.set_catalog([entry(flaky)])
    Flaky.drops = [150_000]
    with build_client(data_dir) as c1:
        set_setting(c1, online_resources="true")
        jid = c1.post("/api/resources/t1/download", json={"accept_license": True}).json()["job_id"]
        for _ in range(100):
            st = c1.get(f"/api/resources/jobs/{jid}").json()
            if st["status"] != "running":
                break
            time.sleep(0.1)
        assert st["status"] == "paused" and st["resumable"]
    # "app restart": a fresh registry and a new app on the same data dir
    manager.JOBS._jobs.clear()
    monkeypatch.setattr(downloads, "MAX_RETRIES", 6)
    with build_client(data_dir) as c2:  # online switch is on -> create_app auto-resumes
        jobs = manager.JOBS.all()
        assert len(jobs) == 1 and jobs[0].fields["resource_id"] == "t1"
        jid2 = jobs[0].id
        for _ in range(100):
            st = c2.get(f"/api/resources/jobs/{jid2}").json()
            if st["status"] in ("done", "failed"):
                break
            time.sleep(0.1)
        assert st["status"] == "done", st
        assert (data_dir / "resources" / "t1" / "file.bin").read_bytes() == BLOB


def test_restart_with_switch_off_stays_paused_until_resume_requested(data_dir, flaky, monkeypatch):
    manager.set_catalog([entry(flaky)])
    st0 = {"key": "res-t1", "url": flaky + "/file.bin", "resource_id": "t1",
           "expected_sha256": SHA, "expected_size": len(BLOB), "license_accepted": True,
           "etag": '"v1"', "total": len(BLOB), "status": "running"}  # fmt: skip
    downloads.save_state(data_dir, "res-t1", st0)
    downloads.part_path(data_dir, "res-t1").write_bytes(BLOB[:200_000])
    manager.JOBS._jobs.clear()
    with build_client(data_dir) as c:
        job = manager.JOBS.all()[0]
        assert job.status == "paused" and job.fields["bytes_done"] == 200_000
        assert not Flaky.requests  # nothing happens while the online switch is off
        r = c.post(f"/api/resources/jobs/{job.id}/resume")
        assert r.json()["error_code"] == "ERR_ONLINE_DISABLED"
        set_setting(c, online_resources="true")
        assert c.post(f"/api/resources/jobs/{job.id}/resume").status_code == 202
        for _ in range(100):
            st = c.get(f"/api/resources/jobs/{job.id}").json()
            if st["status"] in ("done", "failed"):
                break
            time.sleep(0.1)
        assert st["status"] == "done" and Flaky.requests[0]["range"] == "bytes=200000-"
        set_setting(c, online_resources="false")
    # cancelling a paused job removes its partial
    downloads.save_state(data_dir, "res-t1", st0)
    downloads.part_path(data_dir, "res-t1").write_bytes(BLOB[:10])
    manager.JOBS._jobs.clear()
    with build_client(data_dir) as c:
        job = [j for j in manager.JOBS.all() if j.status == "paused"][0]
        assert c.post(f"/api/resources/jobs/{job.id}/cancel").json()["status"] == "cancelled"
        assert not list((data_dir / "downloads").glob("*"))


def test_quran_download_retries_transient_failures(data_dir, monkeypatch):
    from app.quran import store

    monkeypatch.setattr(store.time, "sleep", lambda s: None)
    calls = []
    good = ("1|1|x\n" * 0).encode()

    def post(url, fields):
        calls.append(1)
        if len(calls) < 3:
            raise MizajError("ERR_QURAN_DOWNLOAD", 502, "ar", "en", {})
        return good

    monkeypatch.setattr(store, "validate_tanzil_text", lambda t: {})
    monkeypatch.setattr(store, "_store", lambda *a, **k: Path("p"))
    with build_client(data_dir) as c:
        set_setting(c, online_resources="true")
        out = store.download_quran_text(data_dir, data_dir / "mizaj.db", ("uthmani",), post=post)
    assert out == {"uthmani": Path("p")} and len(calls) == 3


# ---------------------------------------------------------------- 8.4.3 batch resume
def _wait(c, jid, until=("done", "failed", "cancelled", "interrupted")):
    for _ in range(200):
        st = c.get(f"/api/batch/{jid}").json()
        if st["status"] in until:
            return st
        time.sleep(0.05)
    raise AssertionError(st)


def test_batch_resume_after_crash_skips_finished_outputs(data_dir, tmp_path, monkeypatch):
    i, o = tmp_path / "in", tmp_path / "out"
    i.mkdir()
    for n in range(6):
        (i / f"f{n}.txt").write_text(f"كتاب جديد رقم {'ا' * (n + 1)}", encoding="utf-8")
    with build_client(data_dir) as c1:
        jid = c1.post(
            "/api/batch", json={"input_dir": str(i), "output_dir": str(o), "formats": ["txt"]}
        ).json()["job_id"]
        assert _wait(c1, jid)["status"] == "done"
    outs = sorted(o.glob("*.txt"))
    assert len(outs) == 6 and all(batch.output_valid(p) for p in outs)
    good = {p: p.read_bytes() for p in outs}
    # simulate a crash: f2 was being written (no marker, truncated), f4 never started; state=running
    outs[2].write_bytes(b"")
    batch.marker_path(outs[4]).unlink()
    outs[4].unlink()
    sf = batch._state_file(data_dir, jid)
    cfg = json.loads(sf.read_text(encoding="utf-8"))
    cfg["status"] = "running"
    sf.write_text(json.dumps(cfg), encoding="utf-8")
    batch.JOBS._jobs.clear()

    converted = []
    real = batch.convert_file
    monkeypatch.setattr(
        batch, "convert_file", lambda s, *a, **k: converted.append(s.name) or real(s, *a, **k)
    )
    with build_client(data_dir) as c2:  # restarted sidecar
        st = c2.get(f"/api/batch/{jid}").json()
        assert st["status"] == "interrupted" and st["resumable"] and st["total"] == 6
        assert st["succeeded"] == 4
        r = c2.post(f"/api/batch/{jid}/resume")
        assert r.status_code == 202, r.text
        st = _wait(c2, jid, ("done", "failed"))
        assert st["status"] == "done" and st["succeeded"] == 6 and st["resumed"] == 4, st
        assert c2.post("/api/batch/nope/resume").status_code == 404
        assert c2.post(f"/api/batch/{jid}/resume").json()["status"] == "done"  # idempotent
    assert sorted(converted) == ["f2.txt", "f4.txt"]  # only the unfinished ones
    for p in outs:
        assert batch.output_valid(p) and p.read_bytes() == good[p]


def test_batch_cancel_then_resume_in_same_run(ioc, tmp_path):
    i, o = tmp_path / "in", tmp_path / "out"
    i.mkdir()
    for n in range(30):
        (i / f"f{n}.txt").write_text("كتاب جديد " * 50, encoding="utf-8")
    jid = ioc.post(
        "/api/batch", json={"input_dir": str(i), "output_dir": str(o), "formats": ["txt"]}
    ).json()["job_id"]
    ioc.post(f"/api/batch/{jid}/cancel")
    st = _wait(ioc, jid, ("done", "cancelled"))
    if st["status"] == "cancelled":
        assert ioc.post(f"/api/batch/{jid}/resume").status_code == 202
        st = _wait(ioc, jid, ("done", "failed"))
    assert st["status"] == "done" and st["succeeded"] == 30
    assert all(batch.output_valid(p) for p in o.glob("*.txt")) and len(list(o.glob("*.txt"))) == 30


def test_fresh_batch_ignores_stale_done_markers(ioc, tmp_path):
    i, o = tmp_path / "in", tmp_path / "out"
    i.mkdir()
    o.mkdir()
    (i / "a.txt").write_text("كتاب", encoding="utf-8")
    (o / "a.txt").write_text("OLD", encoding="utf-8")
    batch.mark_done(o / "a.txt", i / "a.txt")
    jid = ioc.post(
        "/api/batch",
        json={"input_dir": str(i), "output_dir": str(o), "formats": ["txt"],
              "on_exist": "overwrite"},
    ).json()["job_id"]
    assert _wait(ioc, jid)["status"] == "done"
    assert (o / "a.txt").read_text(encoding="utf-8") != "OLD"


# ---------------------------------------------------------------- 8.4.3 SSE resume
def _sidecar(data_dir):
    env = {**os.environ, "MIZAJ_ENGINE_MODE": "mock", "MIZAJ_PRELOAD": "0"}
    env.pop("MIZAJ_API_TOKEN", None)
    p = subprocess.Popen(
        [sys.executable, "-m", "app.main", "--port", "0", "--data-dir", str(data_dir)],
        cwd=BACKEND, env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    port = int(p.stdout.readline().split("=")[1])
    return p, port


def _text(n_sent=900):
    alpha = "ابتثجحخدذرزسشصضطعغفقكلمنهوي"

    def w(k):
        return alpha[k % 27] + alpha[(k // 27) % 27] + alpha[(k // 729) % 27] + "ا" + alpha[k % 5]

    return " ".join(" ".join(w(s * 9 + j) for j in range(8)) + "." for s in range(n_sent))


def _stream(port, text, stop_after=None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=120)
    conn.request("POST", "/api/tashkeel/stream", json.dumps({"text": text, "mode": "fast"}),
                 {"Content-Type": "application/json"})
    resp = conn.getresponse()
    chunks, done = [], None
    event = None
    while True:
        line = resp.fp.readline()
        if not line:
            break
        line = line.decode("utf-8").rstrip("\n")
        if line.startswith("event:"):
            event = line.split(":", 1)[1].strip()
        elif line.startswith("data:"):
            d = json.loads(line[5:])
            if event == "done":
                done = d
            else:
                chunks.append(d)
                if stop_after and len(chunks) >= stop_after:
                    return chunks, None, conn
    conn.close()
    return chunks, done, None


def test_sse_resumes_from_chunk_cache_after_sidecar_kill(tmp_path):
    text = _text()
    data = tmp_path / "data"
    p, port = _sidecar(data)
    try:
        seen, done, conn = _stream(port, text, stop_after=40)
        assert done is None and len(seen) == 40
        p.kill()  # the sidecar dies mid-stream
        p.wait(10)
        conn.close()
    finally:
        p.kill()
    p2, port2 = _sidecar(data)  # restarted sidecar, same data dir
    try:
        t0 = time.time()
        chunks, done, _ = _stream(port2, text)
        resumed_s = time.time() - t0
    finally:
        p2.terminate()
    assert done is not None and done["chunks"] == len(chunks)
    assert done["cached_chunks"] >= 40  # at least everything the client had already received
    assert all(c["cached"] for c in chunks[:40])
    # same result as an uninterrupted run in a fresh data dir
    p3, port3 = _sidecar(tmp_path / "fresh")
    try:
        fresh, fdone, _ = _stream(port3, text)
    finally:
        p3.terminate()
    assert [c["text"] for c in chunks] == [c["text"] for c in fresh]
    assert fdone["cached_chunks"] == 0 and resumed_s < 120
