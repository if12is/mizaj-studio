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


def pytest_runtest_logreport(report):
    """On GitHub Actions, surface each failing test as an annotation (logs may be hard to reach)."""
    if os.environ.get("GITHUB_ACTIONS") != "true" or not report.failed:
        return
    tail = "\n".join(str(report.longrepr).splitlines()[-15:])
    msg = f"{report.nodeid} ({report.when})\n{tail}"
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"\n::error title=pytest failure::{msg}", flush=True)
