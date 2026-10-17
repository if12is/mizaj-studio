"""Shared fixture for test_phase7_io_*: the app plus the (not yet registered) io routers."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.api import io as io_api
from app.api import packs2 as packs2_api
from app.api import resources as resources_api
from app.api import tools as tools_api
from app.main import create_app

ROUTERS = (io_api, packs2_api, resources_api, tools_api)


def build_client(data_dir) -> TestClient:
    app = create_app(data_dir)
    registered = {id(r.endpoint) for r in app.routes if hasattr(r, "endpoint")}
    for mod in ROUTERS:
        if not any(id(r.endpoint) in registered for r in mod.router.routes):
            app.include_router(mod.router)
    return TestClient(app)


@pytest.fixture
def ioc(data_dir):
    with build_client(data_dir) as c:
        c.data_dir = data_dir
        yield c


def set_setting(c, **kw):
    r = c.put("/api/settings", json={k: v for k, v in kw.items()})
    assert r.status_code == 200, r.text
