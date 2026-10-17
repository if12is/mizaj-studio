"""Lazy, thread-safe, load-once engine registry."""

from __future__ import annotations

import logging
import threading

from app.core.errors import engine_not_ready, model_missing
from app.engine import config
from app.engine.base import Engine
from app.engine.executor import run_blocking
from app.engine.morph_filter import MorphFilter

log = logging.getLogger("mizaj.engine.manager")


class EngineManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._engines: dict[str, Engine] = {}
        self._loading: set[str] = set()
        self._fast_key: str | None = None

    def reset(self) -> None:
        with self._lock:
            self._engines.clear()
            self._loading.clear()
            self._fast_key = None

    # ---- key resolution (cheap, no loading) ----
    def key_for(self, mode: str) -> str:
        if config.env_mock():
            return "mock"
        if mode == "accurate":
            if not config.model_present():
                raise model_missing(str(config.catt_encoder_path()))
            return "catt"
        return self._resolve_fast()

    def _resolve_fast(self) -> str:
        if self._fast_key is None:
            try:
                import libtashkeel  # noqa: F401

                self._fast_key = "libtashkeel"
            except ImportError:
                self._fast_key = "mishkal"
            log.info("fast mode engine: %s", self._fast_key)
        return self._fast_key

    # ---- loading ----
    def _build(self, key: str) -> Engine:
        if key == "mock":
            from app.engine.mock_engine import MockEngine

            return MockEngine()
        if key == "catt":
            from app.engine.catt_engine import CattEngine

            return CattEngine()
        if key == "libtashkeel":
            from app.engine.libtashkeel_engine import LibtashkeelEngine

            return LibtashkeelEngine()
        from app.engine.mishkal_engine import MishkalEngine

        return MishkalEngine()

    def get_sync(self, key: str) -> Engine:
        """Thread-safe: each engine is constructed exactly once."""
        eng = self._engines.get(key)
        if eng is not None:
            return eng
        with self._lock:
            eng = self._engines.get(key)
            if eng is None:
                log.info("loading engine %s", key)
                eng = self._build(key)
                self._engines[key] = eng
        return eng

    async def ensure(self, mode: str) -> Engine:
        """Engine for `mode`; 503 ERR_ENGINE_NOT_READY if another request is loading it."""
        key = self.key_for(mode)
        return await self.ensure_key(key, mode)

    async def ensure_key(self, key: str, mode: str = "") -> Engine:
        eng = self._engines.get(key)
        if eng is not None:
            return eng
        if key in self._loading:
            raise engine_not_ready(mode or key)
        self._loading.add(key)
        try:
            return await run_blocking(self.get_sync, key)
        finally:
            self._loading.discard(key)

    async def ensure_analyzer(self) -> Engine:
        """Engine used for word suggestions (mock in mock mode, else mishkal)."""
        return await self.ensure_key("mock" if config.env_mock() else "mishkal", "analyzer")

    def morph_filter(self) -> MorphFilter:
        from app.engine.mishkal_engine import MishkalEngine

        analyzer = self.get_sync("mishkal")
        assert isinstance(analyzer, MishkalEngine)
        return MorphFilter(analyzer)


manager = EngineManager()
