"""Tiny in-memory job registry shared by batch processing and resource downloads."""

from __future__ import annotations

import threading
import uuid
from datetime import UTC, datetime
from typing import Any


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class Job:
    def __init__(self, kind: str, **fields: Any) -> None:
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.status = "queued"  # queued|running|done|cancelled|failed
        self.cancel_event = threading.Event()
        self.started_at = _now()
        self.finished_at: str | None = None
        self.fields: dict[str, Any] = {"errors": [], **fields}
        self._lock = threading.Lock()

    def update(self, **kw: Any) -> None:
        with self._lock:
            self.fields.update(kw)

    def add_error(self, item: dict[str, Any]) -> None:
        with self._lock:
            self.fields["errors"].append(item)

    def finish(self, status: str) -> None:
        self.status = status
        self.finished_at = _now()

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "id": self.id,
                "kind": self.kind,
                "status": self.status,
                "started_at": self.started_at,
                "finished_at": self.finished_at,
                **{k: (list(v) if isinstance(v, list) else v) for k, v in self.fields.items()},
            }

    @property
    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    @property
    def finished(self) -> bool:
        return self.status in ("done", "cancelled", "failed")


class JobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, Job] = {}

    def add(self, job: Job) -> Job:
        self._jobs[job.id] = job
        while len(self._jobs) > 200:  # drop the oldest finished jobs
            old = next((k for k, j in self._jobs.items() if j.finished), None)
            if old is None:
                break
            del self._jobs[old]
        return job

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def all(self) -> list[Job]:
        return list(self._jobs.values())
