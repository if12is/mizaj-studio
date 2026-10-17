"""DB access for templates + first-run seeding of the starter templates."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from app.core.database import connect, now_iso, write
from app.legal.templates import TemplateError, normalize_vars, validate_template

DATA = Path(__file__).resolve().parent / "data" / "templates.json"
SEED_KEY = "legal_templates_seeded"


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
    """Insert the starter templates once (users may edit or delete them afterwards)."""
    conn = connect(db_path)
    try:
        if conn.execute("SELECT 1 FROM legal_meta WHERE key=?", (SEED_KEY,)).fetchone():
            return 0
        templates = json.loads(DATA.read_text(encoding="utf-8"))["templates"]
        with write(conn):
            for t in templates:
                save_template(conn, {**t, "is_sample": True})
            conn.execute("INSERT INTO legal_meta(key, value) VALUES (?, '1')", (SEED_KEY,))
        return len(templates)
    finally:
        conn.close()
