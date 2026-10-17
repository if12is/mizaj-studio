"""DB access for templates + first-run seeding of the starter templates."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from app.core.database import connect, now_iso, write
from app.legal.templates import TemplateError, normalize_vars, validate_template

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA = DATA_DIR / "templates.json"
# (data file, seed key): each pack is seeded once, so new packs reach existing databases too.
SEED_PACKS = [(DATA, "legal_templates_seeded"),
              (DATA_DIR / "templates_official.json", "legal_templates_official_seeded")]  # fmt: skip
SEED_KEY = SEED_PACKS[0][1]


def row_to_template(r: sqlite3.Row, with_body: bool = True) -> dict[str, Any]:
    d = {
        "id": r["id"], "name": r["name"], "category": r["category"],
        "jurisdiction": r["jurisdiction"], "vars": json.loads(r["vars_json"]),
        "version": r["version"], "is_sample": bool(r["is_sample"]),
        "created_at": r["created_at"], "updated_at": r["updated_at"],
    }  # fmt: skip
    if with_body:
        d["body"] = r["body"]
    return d


def save_template(
    conn: sqlite3.Connection, t: dict[str, Any], template_id: int | None = None
) -> int:
    name = (t.get("name") or "").strip()
    if not name:
        raise TemplateError("name is required")
    vars_ = normalize_vars(t.get("vars", []))
    validate_template(t.get("body", ""), vars_)
    ts = now_iso()
    vals = (name, t.get("category", ""), t.get("jurisdiction", ""), t["body"],
            json.dumps(vars_, ensure_ascii=False), 1 if t.get("is_sample") else 0)  # fmt: skip
    if template_id is None:
        cur = conn.execute(
            "INSERT INTO legal_templates(name, category, jurisdiction, body, vars_json, is_sample,"
            " created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
            (*vals, ts, ts),
        )
        return cur.lastrowid
    conn.execute(
        "UPDATE legal_templates SET name=?, category=?, jurisdiction=?, body=?, vars_json=?, "
        "is_sample=?, version=version+1, updated_at=? WHERE id=?",
        (*vals, ts, template_id),
    )
    return template_id


def seed_templates(db_path: Path) -> int:
    """Insert the starter templates once per pack (users may edit or delete them afterwards)."""
    conn = connect(db_path)
    total = 0
    try:
        for data_file, key in SEED_PACKS:
            if conn.execute("SELECT 1 FROM legal_meta WHERE key=?", (key,)).fetchone():
                continue
            templates = json.loads(data_file.read_text(encoding="utf-8"))["templates"]
            with write(conn):
                for t in templates:
                    save_template(conn, {**t, "is_sample": True})
                conn.execute("INSERT INTO legal_meta(key, value) VALUES (?, '1')", (key,))
            total += len(templates)
        return total
    finally:
        conn.close()
