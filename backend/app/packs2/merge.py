# ruff: noqa: E501
"""Merge planning (preview), apply and undo for `.mizajpack` v2 (7.11.2)."""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from typing import Any

from app.api import settings as settings_api
from app.core.database import now_iso, write
from app.core.errors import MizajError, not_found
from app.engine.normalize import has_arabic_letters, strip_marks
from app.legal import glossary as gl
from app.legal import store as tstore
from app.legal.templates import TemplateError, normalize_vars, validate_template
from app.packs2 import guards
from app.packs2.export import is_shareable_setting
from app.packs2.schema import DATA_KINDS, Pack

DUP_SUFFIX = " (مستورد)"


def _ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _item(key: str, action: str, reason: str, incoming: Any = None, current: Any = None, **x: Any):
    return {"key": key, "action": action, "reason": reason, "incoming": incoming,
            "current": current, **x}  # fmt: skip


# ------------------------------------------------------------------ planning
def plan_dictionary(db: sqlite3.Connection, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items, seen = [], set()
    quran = guards.quran_checker()
    for e in entries:
        key, form = strip_marks(_ws(e["word_or_phrase"])), _ws(e["diacritized_form"])
        inc = {"diacritized_form": form}
        if key in seen:
            items.append(_item(key, "skip", "duplicate_in_pack", inc))
            continue
        seen.add(key)
        if not has_arabic_letters(key):
            items.append(_item(key, "skip", "not_arabic", inc))
        elif strip_marks(form) != key:
            items.append(_item(key, "skip", "base_letters_differ", inc))
        elif form == key:
            items.append(_item(key, "skip", "no_diacritics", inc))
        elif quran is not None and quran(key):
            items.append(_item(key, "skip", "quran_text", inc))
        else:
            row = db.execute(
                "SELECT * FROM tashkeel_cache WHERE word_or_phrase=?", (key,)
            ).fetchone()
            if row is None or not row["is_user_locked"]:
                items.append(
                    _item(
                        key,
                        "add",
                        "new" if row is None else "replaces_cache_entry",
                        inc,
                        row["diacritized_form"] if row else None,
                    )  # fmt: skip
                )
            elif row["diacritized_form"] == form:
                items.append(_item(key, "skip", "identical", inc, form))
            elif row["source"] == "user":
                items.append(_item(key, "conflict", "user_locked", inc, row["diacritized_form"]))
            else:
                items.append(
                    _item(key, "update", "replaces_imported", inc, row["diacritized_form"])
                )
    return items


def plan_glossary(db: sqlite3.Connection, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items, seen = [], set()
    for e in entries:
        try:
            term, dia = gl.validate_entry(e["term"], e["diacritized"])
        except gl.GlossaryError as exc:
            items.append(_item(_ws(e["term"]), "skip", f"invalid: {exc}"))
            continue
        norm = {
            "term": term, "diacritized": dia, "preferred": e.get("preferred") or term,
            "avoid": e.get("avoid", []), "definition": e.get("definition", ""),
            "jurisdiction": e.get("jurisdiction", ""), "source": e.get("source", ""),
            "note": e.get("note", ""), "enabled": bool(e.get("enabled", True)),
        }  # fmt: skip
        if term in seen:
            items.append(_item(term, "skip", "duplicate_in_pack", norm))
            continue
        seen.add(term)
        row = db.execute("SELECT * FROM legal_glossary WHERE term=?", (term,)).fetchone()
        if row is None:
            items.append(_item(term, "add", "new", norm))
            continue
        cur = {
            "term": term, "diacritized": row["diacritized"], "preferred": row["preferred"],
            "avoid": json.loads(row["avoid_json"]), "definition": row["definition"],
            "jurisdiction": row["jurisdiction"], "source": row["source"], "note": row["note"],
            "enabled": bool(row["enabled"]),
        }  # fmt: skip
        if cur == norm:
            items.append(_item(term, "skip", "identical", norm, cur))
        else:
            items.append(_item(term, "conflict", "differs_from_local", norm, cur, id=row["id"]))
    return items


def _tkey(name: str, category: str) -> str:
    return f"{name}|{category}"


def plan_templates(db: sqlite3.Connection, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items, seen = [], set()
    for e in entries:
        name, cat = _ws(e["name"]), _ws(e.get("category", ""))
        key = _tkey(name, cat)
        try:
            vars_ = normalize_vars(e.get("vars", []))
            validate_template(e["body"], vars_)
        except TemplateError as exc:
            items.append(_item(key, "skip", f"invalid: {exc}"))
            continue
        norm = {"name": name, "category": cat, "jurisdiction": e.get("jurisdiction", ""),
                "body": e["body"], "vars": vars_}  # fmt: skip
        if key in seen:
            items.append(_item(key, "skip", "duplicate_in_pack"))
            continue
        seen.add(key)
        row = db.execute(
            "SELECT * FROM legal_templates WHERE name=? AND category=?", (name, cat)
        ).fetchone()
        view = {"name": name, "category": cat, "preview": e["body"][:200]}
        if row is None:
            items.append(_item(key, "add", "new", view))
        elif row["body"] == e["body"] and json.loads(row["vars_json"]) == vars_:
            items.append(_item(key, "skip", "identical", view))
        else:
            cur = {"name": name, "category": cat, "preview": row["body"][:200]}
            items.append(_item(key, "conflict", "differs_from_local", view, cur, id=row["id"],
                               options=["keep", "override", "duplicate"], _full=norm))  # fmt: skip
    for it in items:
        if it["action"] == "add":
            it["_full"] = next(
                {
                    "name": _ws(e["name"]),
                    "category": _ws(e.get("category", "")),
                    "jurisdiction": e.get("jurisdiction", ""),
                    "body": e["body"],
                    "vars": normalize_vars(e.get("vars", [])),
                }  # fmt: skip
                for e in entries
                if _tkey(_ws(e["name"]), _ws(e.get("category", ""))) == it["key"]
            )
    return items


def plan_settings(db: sqlite3.Connection, body: dict[str, str]) -> list[dict[str, Any]]:
    items = []
    cur_all = settings_api._all(db)
    for k, v in sorted(body.items()):
        if not is_shareable_setting(k):
            items.append(_item(k, "skip", "private_setting", v))
            continue
        try:
            settings_api._validate(k, v)
        except MizajError:
            items.append(_item(k, "skip", "invalid_value", v))
            continue
        cur = cur_all.get(k)
        if cur == v:
            items.append(_item(k, "skip", "identical", v, cur))
        else:
            items.append(
                _item(k, "update", "differs_from_local" if cur is not None else "new", v, cur)
            )
    return items


def make_plan(db: sqlite3.Connection, pack: Pack, kinds: list[str] | None = None) -> dict[str, Any]:
    plans: dict[str, list[dict[str, Any]]] = {}
    for k in DATA_KINDS:
        if k not in pack.payloads or (kinds is not None and k not in kinds):
            continue
        p = pack.payloads[k]
        plans[k] = {
            "dictionary": plan_dictionary, "glossary": plan_glossary,
            "templates": plan_templates, "settings": plan_settings,
        }[k](db, p)  # fmt: skip
    return plans


def summarize(plans: dict[str, list[dict[str, Any]]]) -> dict[str, dict[str, int]]:
    out = {}
    for k, items in plans.items():
        c = {"adds": 0, "updates": 0, "conflicts": 0, "skips": 0}
        for it in items:
            c[
                {"add": "adds", "update": "updates", "conflict": "conflicts", "skip": "skips"}[
                    it["action"]
                ]
            ] += 1
        out[k] = c
    return out


def public_plan(plans: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    res = {}
    for k, items in plans.items():
        grouped: dict[str, list] = {"adds": [], "updates": [], "conflicts": [], "skips": []}
        for it in items:
            clean = {a: b for a, b in it.items() if not a.startswith("_")}
            grouped[
                {"add": "adds", "update": "updates", "conflict": "conflicts", "skip": "skips"}[
                    it["action"]
                ]
            ].append(clean)
        res[k] = grouped
    return res


# ------------------------------------------------------------------ apply
def _row(db: sqlite3.Connection, table: str, pk: str, val: Any) -> dict[str, Any] | None:
    r = db.execute(f"SELECT * FROM {table} WHERE {pk}=?", (val,)).fetchone()  # noqa: S608
    return dict(r) if r else None


def _decision(
    decisions: dict[str, dict[str, str]], kind: str, key: str, default: str = "keep"
) -> str:
    return (decisions.get(kind) or {}).get(key, default)


def apply_plan(
    db: sqlite3.Connection, plans: dict[str, list[dict[str, Any]]],
    decisions: dict[str, dict[str, str]],
) -> tuple[list[dict[str, Any]], dict[str, dict[str, int]]]:  # fmt: skip
    """Must run inside write(). Returns (journal, applied counts)."""
    journal: list[dict[str, Any]] = []
    applied = {k: {"added": 0, "updated": 0, "kept_local": 0} for k in plans}
    for kind, items in plans.items():
        for it in items:
            act = it["action"]
            if act == "skip":
                continue
            if act == "conflict":
                dec = _decision(decisions, kind, it["key"])
                if dec == "keep" or dec not in ("override", "duplicate"):
                    applied[kind]["kept_local"] += 1
                    continue
                if dec == "duplicate" and kind != "templates":
                    applied[kind]["kept_local"] += 1
                    continue
                act = "duplicate" if dec == "duplicate" else "update"
            elif act == "update" and _decision(decisions, kind, it["key"], "apply") == "keep":
                applied[kind]["kept_local"] += 1
                continue
            _APPLY[kind](db, it, act, journal)
            applied[kind]["added" if act in ("add", "duplicate") else "updated"] += 1
    return journal, applied


def _apply_dictionary(db, it, act, journal) -> None:
    key, form, ts = it["key"], it["incoming"]["diacritized_form"], now_iso()
    row = _row(db, "tashkeel_cache", "word_or_phrase", key)
    if row is None:
        cur = db.execute(
            "INSERT INTO tashkeel_cache(word_or_phrase, diacritized_form, source, is_user_locked,"
            " created_at, updated_at) VALUES (?,?,'dictionary',1,?,?)",
            (key, form, ts, ts),
        )
        journal.append({"t": "tashkeel_cache", "pk": "id", "op": "delete", "id": cur.lastrowid,
                        "chk": "diacritized_form", "after": form})  # fmt: skip
    else:
        db.execute(
            "UPDATE tashkeel_cache SET diacritized_form=?, source='dictionary', is_user_locked=1,"
            " updated_at=? WHERE id=?",
            (form, ts, row["id"]),
        )
        journal.append({"t": "tashkeel_cache", "pk": "id", "op": "restore", "id": row["id"],
                        "row": row, "chk": "diacritized_form", "after": form})  # fmt: skip


def _apply_glossary(db, it, act, journal) -> None:
    e = it["incoming"]
    ts_before = now_iso()
    if act == "add":
        new_id = gl.save_entry(db, e)
        after = db.execute(
            "SELECT updated_at FROM legal_glossary WHERE id=?", (new_id,)
        ).fetchone()[0]
        journal.append(
            {"t": "legal_glossary", "pk": "id", "op": "delete", "id": new_id, "after": after}
        )
    else:
        old = _row(db, "legal_glossary", "id", it["id"])
        gl.save_entry(db, e, it["id"])
        after = db.execute(
            "SELECT updated_at FROM legal_glossary WHERE id=?", (it["id"],)
        ).fetchone()[0]
        journal.append({"t": "legal_glossary", "pk": "id", "op": "restore", "id": it["id"],
                        "row": old, "after": after})  # fmt: skip
    del ts_before


def _apply_templates(db, it, act, journal) -> None:
    t = dict(it["_full"])
    if act == "duplicate":
        t["name"] += DUP_SUFFIX
    if act in ("add", "duplicate"):
        new_id = tstore.save_template(db, t)
        after = db.execute(
            "SELECT updated_at FROM legal_templates WHERE id=?", (new_id,)
        ).fetchone()[0]
        journal.append(
            {"t": "legal_templates", "pk": "id", "op": "delete", "id": new_id, "after": after}
        )
    else:
        old = _row(db, "legal_templates", "id", it["id"])
        tstore.save_template(db, t, it["id"])
        after = db.execute(
            "SELECT updated_at FROM legal_templates WHERE id=?", (it["id"],)
        ).fetchone()[0]
        journal.append({"t": "legal_templates", "pk": "id", "op": "restore", "id": it["id"],
                        "row": old, "after": after})  # fmt: skip


def _apply_settings(db, it, act, journal) -> None:
    k, v, ts = it["key"], it["incoming"], now_iso()
    old = _row(db, "settings", "key", k)
    db.execute(
        "INSERT INTO settings(key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE "
        "SET value=excluded.value, updated_at=excluded.updated_at",
        (k, v, ts),
    )
    if old is None:
        journal.append({"t": "settings", "pk": "key", "op": "delete", "id": k, "after": ts})
    else:
        journal.append(
            {"t": "settings", "pk": "key", "op": "restore", "id": k, "row": old, "after": ts}
        )


_APPLY = {
    "dictionary": _apply_dictionary, "glossary": _apply_glossary,
    "templates": _apply_templates, "settings": _apply_settings,
}  # fmt: skip


def record_import(db, pack: Pack, kind: str, summary: dict, journal: list) -> str:
    iid = uuid.uuid4().hex[:16]
    m = pack.manifest
    db.execute(
        "INSERT INTO pack_imports(id, kind, name, version, content_sha256, summary_json, "
        "journal_json) VALUES (?,?,?,?,?,?,?)",
        (iid, kind, str(m.get("name", "")), str(m.get("version", "")),
         str(m.get("content_sha256", "")), json.dumps(summary, ensure_ascii=False),
         json.dumps(journal)),
    )  # fmt: skip
    return iid


# ------------------------------------------------------------------ undo
_TABLES = {"tashkeel_cache", "legal_glossary", "legal_templates", "settings"}


def undo_import(db: sqlite3.Connection, import_id: str) -> dict[str, Any]:
    row = db.execute("SELECT * FROM pack_imports WHERE id=?", (import_id,)).fetchone()
    if row is None:
        raise not_found("Import", import_id)
    if row["status"] == "undone":
        raise MizajError("ERR_IMPORT_ALREADY_UNDONE", 409, "تم التراجع عن هذا الاستيراد مسبقاً.",
                         "This import was already undone.", {"id": import_id})  # fmt: skip
    journal = json.loads(row["journal_json"])
    if not journal and row["kind"] == "models":
        raise MizajError("ERR_IMPORT_NOT_UNDOABLE", 409, "لا يمكن التراجع عن حزمة النماذج.",
                         "Model packs cannot be undone.", {"id": import_id})  # fmt: skip
    reverted = skipped = 0
    with write(db):
        for op in reversed(journal):
            t, pk = op["t"], op["pk"]
            if t not in _TABLES or pk not in ("id", "key"):
                continue
            chk = op.get("chk", "updated_at")
            # identifiers are interpolated below: the journal is stored data, so allow only real
            # column names of the table (a tampered journal must never reach the SQL text)
            cols_ok = {r[1] for r in db.execute(f"PRAGMA table_info({t})")}  # noqa: S608
            used = {pk, chk, *(op["row"] if isinstance(op.get("row"), dict) else ())}
            if not used <= cols_ok:
                skipped += 1
                continue
            cur = db.execute(f"SELECT {chk} FROM {t} WHERE {pk}=?", (op["id"],)).fetchone()  # noqa: S608
            if cur is None or cur[0] != op["after"]:
                skipped += 1  # edited or removed by the user since the import
                continue
            if op["op"] == "delete":
                db.execute(f"DELETE FROM {t} WHERE {pk}=?", (op["id"],))  # noqa: S608
            else:
                r = op["row"]
                cols = list(r)
                db.execute(
                    f"INSERT OR REPLACE INTO {t}({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",  # noqa: S608
                    [r[c] for c in cols],
                )
            reverted += 1
        db.execute("UPDATE pack_imports SET status='undone', undone_at=? WHERE id=?",
                   (now_iso(), import_id))  # fmt: skip
    return {"import_id": import_id, "reverted": reverted, "skipped_modified_since": skipped}
