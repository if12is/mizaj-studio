"""Shipped domain packs (7.4.4): valid, importable, in the catalog with matching sha256."""

import hashlib
import json
from pathlib import Path

import pytest

from app.packs2 import merge
from app.packs2.schema import read_pack

ROOT = Path(__file__).resolve().parents[2]
PACKS = ROOT / "resources" / "packs"
CATALOG = ROOT / "backend" / "app" / "resources" / "catalog.json"


def _packs():
    return sorted(PACKS.glob("*.mizajpack"))


def test_three_packs_exist():
    assert len(_packs()) == 3


@pytest.mark.parametrize("path", _packs(), ids=lambda p: p.name)
def test_pack_reads_and_plans_clean(path, tmp_path):
    from app.core.database import connect
    from app.core.migrations import run_migrations

    pack = read_pack(path)
    assert pack.manifest["license"] == "CC0-1.0"
    db_path = tmp_path / "t.db"
    run_migrations(db_path, tmp_path / "bk")
    db = connect(db_path)
    plans = merge.make_plan(db, pack)
    items = [i for v in plans.values() for i in v]
    assert len(items) >= 70
    assert all(i["action"] == "add" for i in items), [i for i in items if i["action"] != "add"][:3]
    db.close()


def test_catalog_entries_match_files():
    cat = json.loads(CATALOG.read_text("utf-8"))["resources"]
    entries = {r["filename"]: r for r in cat if r["kind"] == "mizajpack"}
    assert len(entries) == 3
    for p in _packs():
        e = entries[p.name]
        data = p.read_bytes()
        assert e["sha256"] == hashlib.sha256(data).hexdigest()
        assert e["size"] == len(data)
        assert e["url"] == (
            "https://github.com/if12is/mizaj-studio/releases/latest/download/" + p.name
        )
        assert e["url"].endswith("/" + p.name)
        assert e["license"] == "CC0-1.0"
