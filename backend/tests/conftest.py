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


def _gh_print(line: str) -> None:
    """Print an annotation without ever crashing pytest (Windows consoles may be cp1252)."""
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        print(line.encode("ascii", "backslashreplace").decode("ascii"), flush=True)


def pytest_runtest_logreport(report):
    """On GitHub Actions, surface each failing test as an annotation (logs may be hard to reach)."""
    if os.environ.get("GITHUB_ACTIONS") != "true" or not report.failed:
        return
    tail = "\n".join(str(report.longrepr).splitlines()[-15:])
    msg = f"{report.nodeid} ({report.when})\n{tail}"
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    _gh_print(f"\n::error title=pytest failure::{msg}")


def pytest_collectreport(report):
    """Also surface collection errors (import failures) as annotations on GitHub Actions."""
    if os.environ.get("GITHUB_ACTIONS") != "true" or not report.failed:
        return
    tail = "\n".join(str(report.longrepr).splitlines()[-15:])
    msg = f"collection error in {report.nodeid}\n{tail}"
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    _gh_print(f"\n::error title=pytest collection::{msg}")


def pytest_sessionfinish(session, exitstatus):
    if os.environ.get("GITHUB_ACTIONS") == "true" and exitstatus not in (0, 5):
        print(
            f"\n::error title=pytest session::exit status {int(exitstatus)}; "
            f"failed={session.testsfailed} collected={session.testscollected}",
            flush=True,
        )
