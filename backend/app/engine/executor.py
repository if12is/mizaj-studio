"""Single bounded executor for ALL engine / mishkal / onnx work (threading-model.md)."""

from __future__ import annotations

import asyncio
import functools
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Any, TypeVar

T = TypeVar("T")
THREAD_PREFIX = "mizaj-engine"
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix=THREAD_PREFIX)


def get_executor() -> ThreadPoolExecutor:
    return _EXECUTOR


async def run_blocking(fn: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(get_executor(), functools.partial(fn, *args, **kwargs))
