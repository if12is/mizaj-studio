from __future__ import annotations

import sqlite3
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field

from app.api.deps import get_db
from app.core.database import write
from app.core.errors import not_found, validation_error
from app.legal import citations as cit
from app.legal import compare as cmp
from app.legal import glossary as gl
from app.legal import lint as lnt
from app.legal import redact as rdc
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


# ------------------------------------------------------------------ linter (7.10.6 / 7.10.12)
class LintIn(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    rules: list[str] | None = None  # only these rules (default: all)
    disabled: list[str] = []
    doc_type: str | None = None  # also run the mandatory-sections checklist


@router.get("/lint/rules")
def lint_rules() -> dict[str, Any]:
    return {
        "rules": [{"id": k, **v} for k, v in lnt.RULES.items()],
        "doc_types": [{"id": k, "title_ar": v["title_ar"]} for k, v in lnt.DOC_TYPES.items()],
    }


@router.post("/lint")
def lint_text(body: LintIn) -> dict[str, Any]:
    unknown = [r for r in [*(body.rules or []), *body.disabled] if r not in lnt.RULES]
    if unknown:
        raise validation_error("unknown rule: " + ", ".join(unknown), {"field": "rules"})
    out = lnt.lint(body.text, body.rules, body.disabled)
    if body.doc_type:
        if body.doc_type not in lnt.DOC_TYPES:
            raise validation_error("unknown doc_type", {"field": "doc_type"})
        out["structure"] = lnt.check_structure(body.text, body.doc_type)
    return out


# ------------------------------------------------------------------ citations (7.10.9)
def _index_path(request: Request):
    return request.app.state.data_dir / "legal" / "law_index.json"


def _load_index(request: Request) -> dict[str, Any] | None:
    import json

    p = _index_path(request)
    try:
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    except (OSError, ValueError):
        return None


class CitationsIn(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    style: Literal["paren", "plain"] = "paren"  # "المادة (5)" or "المادة 5"
    use_index: bool = True


@router.post("/citations")
def citations(body: CitationsIn, request: Request) -> dict[str, Any]:
    idx = _load_index(request) if body.use_index else None
    return cit.analyze_citations(body.text, idx, body.style)


@router.get("/law-index")
def get_law_index(request: Request) -> dict[str, Any]:
    return _load_index(request) or {"version": 1, "kind": cit.INDEX_KIND, "laws": []}


@router.put("/law-index")
def put_law_index(body: dict[str, Any], request: Request) -> dict[str, Any]:
    import json
    import os

    try:
        idx = cit.validate_index(body)
    except cit.IndexError_ as exc:
        raise validation_error(str(exc), {"field": "laws"}) from exc
    p = _index_path(request)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(idx, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)
    return {"count": len(idx["laws"])}


@router.delete("/law-index", status_code=204)
def delete_law_index(request: Request) -> Response:
    _index_path(request).unlink(missing_ok=True)
    return Response(status_code=204)


# ------------------------------------------------------------------ redaction (7.10.10)
class RedactIn(BaseModel):
    text: str = Field(max_length=MAX_TEXT)
    categories: (
        list[Literal["id", "phone", "email", "iban", "card", "passport", "name", "party"]] | None
    ) = None
    style: Literal["mask", "placeholder", "pseudonym"] = "placeholder"
    names: list[str] = Field(default=[], max_length=500)  # extra names to find (user list)
    use_parties: bool = True  # names taken from party definitions (7.10.4)


@router.post("/redact")
def redact_text(body: RedactIn) -> dict[str, Any]:
    """Proposals only: the text is never changed and nothing is stored."""
    return rdc.redact(body.text, body.categories, body.style, body.names, body.use_parties)


# ------------------------------------------------------------------ compare (7.10.11)
class CompareIn(BaseModel):
    a: str | None = Field(default=None, max_length=MAX_TEXT)
    b: str | None = Field(default=None, max_length=MAX_TEXT)
    document_a: int | None = None
    document_b: int | None = None


@router.post("/compare")
def compare(body: CompareIn, db: Db) -> dict[str, Any]:
    def side(text: str | None, doc: int | None, field: str) -> str:
        if text is not None:
            return text
        if doc is None:
            raise validation_error("give either text or a document id", {"field": field})
        row = db.execute(
            "SELECT raw_content FROM documents WHERE id=? AND is_deleted=0", (doc,)
        ).fetchone()
        if row is None:
            raise not_found("Document", doc)
        return row["raw_content"]

    a = side(body.a, body.document_a, "a")
    b = side(body.b, body.document_b, "b")
    return cmp.compare_texts(a, b)
