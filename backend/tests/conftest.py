import os

os.environ["MIZAJ_ENGINE_MODE"] = "mock"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import create_app  # noqa: E402


@pytest.fixture
def data_dir(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    return d


@pytest.fixture
def client(data_dir):
    app = create_app(data_dir)
    with TestClient(app) as c:
        c.data_dir = data_dir
        yield c


@pytest.fixture(autouse=True)
def _reset_engines(monkeypatch):
    from app.engine.manager import manager

    monkeypatch.setenv("MIZAJ_ENGINE_MODE", "mock")
    manager.reset()
    yield
    manager.reset()
