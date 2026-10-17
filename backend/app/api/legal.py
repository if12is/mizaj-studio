from __future__ import annotations

import sqlite3
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, Field

from app.api.deps import get_db
from app.core.database import write
from app.core.errors import not_found, validation_error
from app.legal import glossary as gl
from app.legal import store
from app.legal.amounts import check_amounts
from app.legal.dates import date_words
from app.legal.defined_terms import analyze_terms
from app.legal.numbering import analyze_clauses
from app.legal.tafqeet import TafqeetError, amount_words, currencies, number_words, parse_amount
from app.legal.templates import TemplateError, render

router = APIRouter(prefix="/api/legal", tags=["legal"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]
MAX_TEXT = 2_000_000


class TextIn(BaseModel):
    text: str = Field(max_length=MAX_TEXT)


# ------------------------------------------------------------------ tafqeet
class TafqeetIn(BaseModel):
    amount: str | int | float
    currency: str | None = None  # None -> plain number in words
    case: Literal["nominative", "accusative", "genitive"] = "nominative"
    style: Literal["plain", "legal"] = "plain"
    adjective: bool = True
    spelling: Literal["ma'a", "mi'a"] = "ma'a"
    minor: Literal["words", "fraction"] = "words"
    gender: Literal["m", "f"] = "m"  # only for plain numbers (no currency)


@router.post("/tafqeet")
def tafqeet(body: TafqeetIn) -> dict[str, Any]:
    try:
        if body.currency:
            r = amount_words(
                body.amount, body.currency, body.case, adjective=body.adjective,
                spelling=body.spelling, minor=body.minor, legal=body.style == "legal",
            )  # fmt: skip
        else:
            d = parse_amount(body.amount)
            if d != d.to_integral_value():
                raise TafqeetError(
                    "a plain number must be an integer (give a currency for decimals)"
                )
            w = number_words(int(d), body.gender, body.case, spelling=body.spelling)
            r = {"words": w, "formula": f"فَقَطْ {w} لَا غَيْرُ" if body.style == "legal" else w}
    except TafqeetError as exc:
        raise validation_error(str(exc), {"field": "amount"}) from exc
    return {**r, "currency": body.currency.upper() if body.currency else None,
            "amount": str(body.amount)}  # fmt: skip


@router.get("/currencies")
def list_currencies() -> list[dict[str, Any]]:
    return [
        {
            "code": code, "country": c["country"], "name": c["sing"], "gender": c["gender"],
            "subunits": [{"name": s["sing"], "gender": s["gender"], "digits": s["digits"]}
                         for s in c["subunits"]],
        }
        for code, c in currencies().items()
    ]  # fmt: skip


@router.post("/check-amounts")
def check(body: TextIn) -> dict[str, Any]:
    issues = check_amounts(body.text)
    return {"issues": issues, "count": len(issues)}


# ------------------------------------------------------------------ dates
class DateIn(BaseModel):
    date: str = Field(pattern=r"^\d{1,4}-\d{1,2}-\d{1,2}$")
    calendar: Literal["gregorian", "hijri"] = "gregorian"
    hijri_adjust: Literal[-1, 0, 1] = 0
    gregorian_names: Literal["gulf", "levant"] = "gulf"
    spelling: Literal["ma'a", "mi'a"] = "ma'a"
    case: Literal["nominative", "accusative", "genitive"] = "nominative"
    with_day_name: bool = True
    claimed_day_name: str | None = None


@router.post("/date-words")
def date_to_words(body: DateIn) -> dict[str, Any]:
    y, m, d = (int(x) for x in body.date.split("-"))
    try:
        return date_words(
            y, m, d, body.calendar, hijri_adjust=body.hijri_adjust,
            gregorian_names=body.gregorian_names, spelling=body.spelling, case=body.case,
            with_day_name=body.with_day_name, claimed_day_name=body.claimed_day_name,
        )  # fmt: skip
    except TafqeetError as exc:
        raise validation_error(str(exc), {"field": "date"}) from exc


# ------------------------------------------------------------------ terms / clauses
@router.post("/defined-terms")
def defined_terms(body: TextIn) -> dict[str, Any]:
    return analyze_terms(body.text)


@router.post("/clauses")
def clauses(body: TextIn) -> dict[str, Any]:
    return analyze_clauses(body.text)


# ------------------------------------------------------------------ glossary
class GlossaryIn(BaseModel):
    term: str = Field(min_length=1, max_length=200)
    diacritized: str = Field(min_length=1, max_length=400)
    preferred: str = ""
    avoid: list[str] = []
    definition: str = ""
    jurisdiction: str = ""
    source: str = ""
    note: str = ""
    enabled: bool = True


def _entry_json(e: gl.Entry) -> dict[str, Any]:
    return {
        "id": e.id,
        "term": e.term,
        "diacritized": e.diacritized,
        "preferred": e.preferred or e.term,
        "avoid": list(e.avoid),
        "definition": e.definition,
        "jurisdiction": e.jurisdiction,
        "source": e.source,
        "note": e.note,
        "builtin": e.builtin,
    }


@router.get("/glossary")
def list_glossary(db: Db, q: str | None = None) -> list[dict[str, Any]]:
    from app.engine.normalize import strip_marks

    out = [_entry_json(e) for e in gl.load_entries(db)]
    if q and q.strip():
        needle = strip_marks(q.strip())
        out = [e for e in out if needle in e["term"] or needle in strip_marks(e["preferred"])]
    return out


def _save(db: sqlite3.Connection, body: GlossaryIn, entry_id: int | None = None) -> int:
    try:
        with write(db):
            return gl.save_entry(db, body.model_dump(), entry_id)
    except gl.GlossaryError as exc:
        raise validation_error(str(exc)) from exc
    except sqlite3.IntegrityError as exc:
        raise validation_error("term already exists in the user glossary") from exc


@router.post("/glossary", status_code=201)
def add_glossary(body: GlossaryIn, db: Db) -> dict[str, Any]:
    new_id = _save(db, body)
    return _entry_json(
        gl.row_to_entry(db.execute("SELECT * FROM legal_glossary WHERE id=?", (new_id,)).fetchone())
    )


@router.put("/glossary/{eid}")
def update_glossary(eid: int, body: GlossaryIn, db: Db) -> dict[str, Any]:
    if db.execute("SELECT 1 FROM legal_glossary WHERE id=?", (eid,)).fetchone() is None:
        raise not_found("Glossary entry", eid)
    _save(db, body, eid)
    return _entry_json(
        gl.row_to_entry(db.execute("SELECT * FROM legal_glossary WHERE id=?", (eid,)).fetchone())
    )


@router.delete("/glossary/{eid}", status_code=204)
def delete_glossary(eid: int, db: Db) -> Response:
    if db.execute("SELECT 1 FROM legal_glossary WHERE id=?", (eid,)).fetchone() is None:
        raise not_found("Glossary entry", eid)
    with write(db):
        db.execute("DELETE FROM legal_glossary WHERE id=?", (eid,))
    return Response(status_code=204)


class GlossaryImport(BaseModel):
    entries: list[GlossaryIn]


@router.post("/glossary/import")
def import_glossary(body: GlossaryImport, db: Db) -> dict[str, int]:
    imported = updated = 0
    try:
        with write(db):
            for e in body.entries:
                row = db.execute(
                    "SELECT id FROM legal_glossary WHERE term=?", (e.term.strip(),)
                ).fetchone()
                gl.save_entry(db, e.model_dump(), row["id"] if row else None)
                updated += bool(row)
                imported += not row
    except gl.GlossaryError as exc:
        raise validation_error(str(exc)) from exc
    return {"imported": imported, "updated": updated}


@router.get("/glossary/export")
def export_glossary(db: Db) -> dict[str, Any]:
    rows = [gl.row_to_entry(r) for r in db.execute("SELECT * FROM legal_glossary ORDER BY id")]
    return {"version": 1, "kind": "glossary", "entries": [
        {**_entry_json(e), "enabled": True} for e in rows]}  # fmt: skip


@router.post("/glossary/check")
def check_glossary(body: TextIn, db: Db) -> dict[str, Any]:
    issues = gl.check_text(body.text, gl.load_entries(db))
    return {"issues": issues, "count": len(issues)}


# ------------------------------------------------------------------ templates
class VarIn(BaseModel):
    name: str
    type: Literal["text", "party", "money", "date", "number", "choice"] = "text"
    required: bool = True
    label: str | None = None
    default: Any = None
    choices: list[str] | None = None
    currency: str | None = None
    calendar: Literal["gregorian", "hijri"] | None = None


class TemplateIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    category: str = ""
    jurisdiction: str = ""
    body: str
    vars: list[VarIn] = []
    is_sample: bool = False


def _tpl_dict(t: TemplateIn) -> dict[str, Any]:
    d = t.model_dump()
    d["vars"] = [{k: v for k, v in x.items() if v is not None} for x in d["vars"]]
    return d


def _tpl_row(db: sqlite3.Connection, tid: int) -> sqlite3.Row:
    row = db.execute("SELECT * FROM legal_templates WHERE id=?", (tid,)).fetchone()
    if row is None:
        raise not_found("Template", tid)
    return row


@router.get("/templates")
def list_templates(db: Db, category: str | None = None) -> list[dict[str, Any]]:
    sql = "SELECT * FROM legal_templates"
    args: tuple = ()
    if category:
        sql += " WHERE category=?"
        args = (category,)
    rows = db.execute(sql + " ORDER BY id", args).fetchall()
    return [store.row_to_template(r, with_body=False) for r in rows]


@router.post("/templates", status_code=201)
def create_template(body: TemplateIn, db: Db) -> dict[str, Any]:
    try:
        with write(db):
            tid = store.save_template(db, _tpl_dict(body))
    except TemplateError as exc:
        raise validation_error(str(exc), {"field": "body"}) from exc
    return store.row_to_template(_tpl_row(db, tid))


@router.get("/templates/export")
def export_templates(db: Db) -> dict[str, Any]:
    rows = db.execute("SELECT * FROM legal_templates ORDER BY id").fetchall()
    items = []
    for r in rows:
        t = store.row_to_template(r)
        items.append(
            {k: t[k] for k in ("name", "category", "jurisdiction", "body", "vars", "is_sample")}
        )
    return {"version": 1, "kind": "templates", "templates": items}


class TemplateImport(BaseModel):
    templates: list[TemplateIn]


@router.post("/templates/import", status_code=201)
def import_templates(body: TemplateImport, db: Db) -> dict[str, Any]:
    ids = []
    try:
        with write(db):
            for t in body.templates:
                ids.append(store.save_template(db, _tpl_dict(t)))
    except TemplateError as exc:
        raise validation_error(str(exc), {"field": "templates"}) from exc
    return {"imported": len(ids), "ids": ids}


class PreviewIn(BaseModel):
    body: str
    vars: list[VarIn] = []
    values: dict[str, Any] = {}


@router.post("/templates/preview")
def preview_template(body: PreviewIn) -> dict[str, Any]:
    try:
        v = [{k: x for k, x in vv.model_dump().items() if x is not None} for vv in body.vars]
        return render(body.body, v, body.values)
    except TemplateError as exc:
        raise validation_error(str(exc), {"field": "body"}) from exc


@router.get("/templates/{tid}")
def get_template(tid: int, db: Db) -> dict[str, Any]:
    return store.row_to_template(_tpl_row(db, tid))


@router.put("/templates/{tid}")
def update_template(tid: int, body: TemplateIn, db: Db) -> dict[str, Any]:
    _tpl_row(db, tid)
    try:
        with write(db):
            store.save_template(db, _tpl_dict(body), tid)
    except TemplateError as exc:
        raise validation_error(str(exc), {"field": "body"}) from exc
    return store.row_to_template(_tpl_row(db, tid))


@router.delete("/templates/{tid}", status_code=204)
def delete_template(tid: int, db: Db) -> Response:
    _tpl_row(db, tid)
    with write(db):
        db.execute("DELETE FROM legal_templates WHERE id=?", (tid,))
    return Response(status_code=204)


class RenderIn(BaseModel):
    values: dict[str, Any] = {}


@router.post("/templates/{tid}/render")
def render_template(tid: int, body: RenderIn, db: Db) -> dict[str, Any]:
    t = store.row_to_template(_tpl_row(db, tid))
    try:
        return {**render(t["body"], t["vars"], body.values), "template_id": tid}
    except TemplateError as exc:
        raise validation_error(str(exc), {"field": "body"}) from exc
