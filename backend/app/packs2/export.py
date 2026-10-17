# ruff: noqa: E501
"""Selective `.mizajpack` v2 export (7.11.1/3/4)."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.api.health import VERSION
from app.api.settings import _all as all_settings
from app.core.errors import validation_error
from app.packs2.schema import DATA_KINDS, PAYLOAD_FILE

SHAREABLE_SETTINGS = {
    "engine_mode", "tashkeel_level", "editor_font", "editor_font_size", "colored_diacritics", "theme",
}  # fmt: skip
SHAREABLE_PREFIXES = ("editor_", "spell_", "ui_", "tashkeel_")
SECRET_HINTS = ("token", "secret", "password", "path", "dir", "email", "key", "online_", "recent")


def is_shareable_setting(key: str) -> bool:
    if any(h in key.lower() for h in SECRET_HINTS if h != "key") or key.lower().endswith("key"):
        return False
    return key in SHAREABLE_SETTINGS or key.startswith(SHAREABLE_PREFIXES)


def _dictionary(db: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = db.execute(
        "SELECT word_or_phrase, diacritized_form FROM tashkeel_cache WHERE is_user_locked=1 "
        "ORDER BY id"
    ).fetchall()
    return [dict(r) for r in rows]


def _glossary(db: sqlite3.Connection) -> list[dict[str, Any]]:
    out = []
    for r in db.execute("SELECT * FROM legal_glossary ORDER BY id"):
        out.append(
            {
                "term": r["term"], "diacritized": r["diacritized"], "preferred": r["preferred"],
                "avoid": json.loads(r["avoid_json"] or "[]"), "definition": r["definition"],
                "jurisdiction": r["jurisdiction"], "source": r["source"], "note": r["note"],
                "enabled": bool(r["enabled"]),
            }
        )  # fmt: skip
    return out


def _templates(db: sqlite3.Connection, include_samples: bool) -> list[dict[str, Any]]:
    sql = "SELECT * FROM legal_templates" + ("" if include_samples else " WHERE is_sample=0")
    return [
        {
            "name": r["name"], "category": r["category"], "jurisdiction": r["jurisdiction"],
            "body": r["body"], "vars": json.loads(r["vars_json"] or "[]"), "version": r["version"],
        }
        for r in db.execute(sql + " ORDER BY id")
    ]  # fmt: skip


def build_payloads(
    db: sqlite3.Connection, kinds: list[str], include_samples: bool, include_private: bool
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in kinds:
        if k == "dictionary":
            out[k] = {"entries": _dictionary(db)}
        elif k == "glossary":
            out[k] = {"entries": _glossary(db)}
        elif k == "templates":
            out[k] = {"templates": _templates(db, include_samples)}
        elif k == "settings":
            s = all_settings(db)
            if not include_private:
                s = {a: b for a, b in s.items() if is_shareable_setting(a)}
            else:  # never export obvious secrets even when private settings are requested
                s = {
                    a: b
                    for a, b in s.items()
                    if not any(h in a.lower() for h in ("token", "secret", "password"))
                }
            out[k] = {"settings": s}
    return out


def count(kind: str, payload: Any) -> int:
    body = payload[
        "settings" if kind == "settings" else "templates" if kind == "templates" else "entries"
    ]
    return len(body)


def export_pack(
    db: sqlite3.Connection,
    target: Path,
    kinds: list[str],
    *,
    name: str,
    version: str,
    license: str,
    author: str = "",
    attribution: str = "",
    description: str = "",
    include_samples: bool = False,
    include_private_settings: bool = False,
) -> dict[str, Any]:
    kinds = [k for k in DATA_KINDS if k in set(kinds)]
    if not kinds:
        raise validation_error("choose at least one kind", {"allowed": list(DATA_KINDS)})
    if not license.strip():
        raise validation_error("license is required when exporting a pack")
    payloads = build_payloads(db, kinds, include_samples, include_private_settings)
    files, blobs = [], {}
    for k in kinds:
        data = json.dumps(payloads[k], ensure_ascii=False, indent=1).encode("utf-8")
        blobs[PAYLOAD_FILE[k]] = data
        files.append(
            {
                "path": PAYLOAD_FILE[k],
                "kind": k,
                "size": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }  # fmt: skip
        )
    manifest = {
        "format": 2,
        "kind": kinds[0] if len(kinds) == 1 else "bundle",
        "version": version,
        "schema_version": 1,
        "name": name,
        "author": author,
        "created_at": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "app_version": VERSION,
        "min_app_version": VERSION,
        "license": license,
        "attribution": attribution,
        "description": description,
        "entries": {k: count(k, payloads[k]) for k in kinds},
        "files": files,
        "content_sha256": hashlib.sha256("".join(f["sha256"] for f in files).encode()).hexdigest(),
    }
    target = Path(target)
    tmp = target.with_name(f".~mizaj_tmp.{uuid.uuid4().hex[:8]}.mizajpack")
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
            for n, data in blobs.items():
                zf.writestr(n, data)
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    return {"path": str(target), "manifest": manifest}
