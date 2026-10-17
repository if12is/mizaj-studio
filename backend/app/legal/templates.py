"""Safe contract-template engine (Task 7.10.1).

A deliberately tiny, non-Turing-complete language parsed by hand - no Jinja, no eval:

    {{ name }}                      value of a variable (type decides the default rendering)
    {{ party.name }}                field of a party variable (name, role, id_number, address,
                                    nationality)
    {{ amount:rent }}               "1,500.00 (words)"  (money variable)
    {{ money:rent|currency=EGP|case=genitive|legal=true }}   words only
    {{ figures:rent }}              figures only, thousands separated
    {{ words:days }}                number (or counted) in words
    {{ ordinal:n|fem=true|case=genitive }}   ordinal word
    {{ date:start|calendar=hijri|names=levant|day=false }}   date in words
    {{#if name}} ... {{else}} ... {{/if}}      also: {{#if kind == "x"}} / != "x"

Variable types: text, number, money, date, party, choice (required / default / choices).
Rendering validates every value and reports problems instead of producing a silently wrong
contract; unresolved placeholders are left visible as [[name]].
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from app.legal.dates import date_words
from app.legal.numbering import ordinal
from app.legal.tafqeet import (
    TafqeetError,
    amount_words,
    currencies,
    norm_case,
    number_words,
    parse_amount,
)

TYPES = ("text", "party", "money", "date", "number", "choice")
MAX_BODY = 200_000
MAX_VARS = 100
NAME_RE = re.compile(r"^[A-Za-z_\u0621-\u064a][\w\u0621-\u0652]*$")
PARTY_FIELDS = ("name", "role", "id_number", "address", "nationality")
_TAG = re.compile(r"\{\{(.*?)\}\}", re.S)
FILTERS = {"amount", "money", "figures", "words", "ordinal", "date"}


class TemplateError(ValueError):
    pass


# ------------------------------------------------------------------ AST
@dataclass
class Text:
    value: str


@dataclass
class Expr:
    filter: str | None
    name: str
    field: str | None
    opts: dict[str, str]
    pos: int


@dataclass
class If:
    name: str
    op: str | None  # None | "==" | "!="
    literal: str | None
    then: list[Any] = field(default_factory=list)
    other: list[Any] = field(default_factory=list)
    pos: int = 0


def _parse_expr(src: str, pos: int) -> Expr:
    parts = [p.strip() for p in src.split("|")]
    head = parts[0]
    flt = None
    if ":" in head:
        flt, head = (x.strip() for x in head.split(":", 1))
        if flt not in FILTERS:
            raise TemplateError(f"unknown filter '{flt}' at {pos}")
    name, _, fld = head.partition(".")
    if not NAME_RE.match(name) or (fld and fld not in PARTY_FIELDS):
        raise TemplateError(f"invalid variable reference '{head}' at {pos}")
    opts: dict[str, str] = {}
    for p in parts[1:]:
        k, eq, v = p.partition("=")
        if not eq or not k.strip():
            raise TemplateError(f"invalid option '{p}' at {pos}")
        opts[k.strip()] = v.strip()
    return Expr(flt, name, fld or None, opts, pos)


def parse(body: str) -> list[Any]:
    if len(body) > MAX_BODY:
        raise TemplateError("template too large")
    root: list[Any] = []
    stack: list[tuple[If, list[Any]]] = []  # (node, parent list)
    cur = root
    pos = 0
    for m in _TAG.finditer(body):
        if m.start() > pos:
            cur.append(Text(body[pos : m.start()]))
        pos = m.end()
        src = m.group(1).strip()
        if src.startswith("#if"):
            cond = src[3:].strip()
            cm = re.fullmatch(r'([^\s=!]+)\s*(?:(==|!=)\s*"([^"]*)")?', cond)
            if not cm or not NAME_RE.match(cm.group(1)):
                raise TemplateError(f"invalid condition '{cond}' at {m.start()}")
            node = If(cm.group(1), cm.group(2), cm.group(3), pos=m.start())
            cur.append(node)
            stack.append((node, cur))
            cur = node.then
        elif src == "else":
            if not stack or cur is not stack[-1][0].then:
                raise TemplateError(f"unexpected {{{{else}}}} at {m.start()}")
            cur = stack[-1][0].other
        elif src == "/if":
            if not stack:
                raise TemplateError(f"unexpected {{{{/if}}}} at {m.start()}")
            _, cur = stack.pop()
        elif src.startswith("#") or src.startswith("/"):
            raise TemplateError(f"unknown block '{src}' at {m.start()}")
        else:
            cur.append(_parse_expr(src, m.start()))
    if stack:
        raise TemplateError("unclosed {{#if}} block")
    if pos < len(body):
        cur.append(Text(body[pos:]))
    return root


def referenced_names(ast: list[Any]) -> set[str]:
    out: set[str] = set()
    for n in ast:
        if isinstance(n, Expr):
            out.add(n.name)
        elif isinstance(n, If):
            out.add(n.name)
            out |= referenced_names(n.then) | referenced_names(n.other)
    return out


# ------------------------------------------------------------------ definitions
def normalize_vars(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or len(raw) > MAX_VARS:
        raise TemplateError("vars must be a list (max 100)")
    out, seen = [], set()
    for v in raw:
        if not isinstance(v, dict):
            raise TemplateError("each variable must be an object")
        name, typ = v.get("name"), v.get("type", "text")
        if not isinstance(name, str) or not NAME_RE.match(name):
            raise TemplateError(f"invalid variable name: {name!r}")
        if name in seen:
            raise TemplateError(f"duplicate variable: {name}")
        if typ not in TYPES:
            raise TemplateError(f"unknown variable type: {typ}")
        if typ == "choice" and not (isinstance(v.get("choices"), list) and v["choices"]):
            raise TemplateError(f"choice variable '{name}' needs choices")
        if typ == "money" and v.get("currency") and v["currency"].upper() not in currencies():
            raise TemplateError(f"unknown currency for '{name}'")
        seen.add(name)
        item = {"name": name, "type": typ, "required": bool(v.get("required", True)),
                "label": v.get("label", name)}  # fmt: skip
        for k in ("default", "choices", "currency", "calendar"):
            if k in v:
                item[k] = v[k]
        out.append(item)
    return out


def validate_template(body: str, vars_: list[dict[str, Any]]) -> dict[str, Any]:
    """Parse + cross-check; raises TemplateError on structural problems."""
    ast = parse(body)
    defs = {v["name"] for v in normalize_vars(vars_)}
    refs = referenced_names(ast)
    undefined = sorted(refs - defs)
    if undefined:
        raise TemplateError("undefined variables: " + ", ".join(undefined))
    return {"unused_variables": sorted(defs - refs), "referenced": sorted(refs)}


# ------------------------------------------------------------------ rendering
def _fmt_figures(amount: Decimal) -> str:
    s = format(amount, "f")
    whole, _, frac = s.partition(".")
    whole = f"{int(whole):,}"
    return whole + ("." + frac if frac and frac.strip("0") else "")


def _bool(opt: str | None, default: bool) -> bool:
    return default if opt is None else opt.lower() in ("1", "true", "yes", "نعم")


class _Ctx:
    def __init__(self, defs: dict[str, dict[str, Any]], values: dict[str, Any]) -> None:
        self.defs, self.values = defs, values
        self.errors: list[dict[str, str]] = []

    def err(self, var: str, code: str, msg: str) -> None:
        if not any(e["var"] == var and e["code"] == code for e in self.errors):
            self.errors.append({"var": var, "code": code, "message": msg})

    def value(self, name: str) -> Any:
        v = self.values.get(name)
        d = self.defs[name]
        if v in (None, "") and "default" in d:
            return d["default"]
        return v

    def present(self, name: str) -> bool:
        v = self.value(name)
        return not (v is None or v == "" or v is False or v == {} or v == [])


def _money_parts(ctx: _Ctx, name: str, opts: dict[str, str]) -> tuple[str, str] | None:
    v = ctx.value(name)
    d = ctx.defs[name]
    cur = opts.get("currency")
    amount: Any = v
    if isinstance(v, dict):
        amount, cur = v.get("amount"), cur or v.get("currency")
    cur = cur or d.get("currency")
    if amount in (None, ""):
        return None
    if not cur:
        ctx.err(name, "currency_missing", f"'{name}' needs a currency")
        return None
    try:
        parse_amount(amount)
    except TafqeetError:
        ctx.err(name, "invalid_amount", f"'{name}' is not a valid amount")
        return None
    if str(cur).upper() not in currencies():
        ctx.err(name, "unknown_currency", f"unknown currency '{cur}'")
        return None
    return str(amount), str(cur).upper()


def _render_expr(e: Expr, ctx: _Ctx) -> str:
    d = ctx.defs[e.name]
    typ = d["type"]
    placeholder = f"[[{e.name}]]"
    v = ctx.value(e.name)
    if v in (None, ""):
        if d["required"]:
            ctx.err(e.name, "missing", f"'{e.name}' is required")
        return placeholder
    try:
        if e.field:
            if typ != "party" or not isinstance(v, dict):
                ctx.err(e.name, "not_party", f"'{e.name}' is not a party")
                return placeholder
            return str(v.get(e.field, "") or f"[[{e.name}.{e.field}]]")
        if e.filter in ("money", "amount", "figures"):
            mp = _money_parts(ctx, e.name, e.opts)
            if mp is None:
                return placeholder
            amount, cur = mp
            if e.filter == "figures":
                return _fmt_figures(parse_amount(amount))
            res = amount_words(
                amount, cur, e.opts.get("case"),
                adjective=_bool(e.opts.get("adjective"), True),
                spelling=e.opts.get("spelling", "ma'a"),
                legal=_bool(e.opts.get("legal"), False),
            )  # fmt: skip
            words = res["formula"]
            return (
                words if e.filter == "money" else f"{_fmt_figures(parse_amount(amount))} ({words})"
            )
        if e.filter == "words":
            return number_words(
                int(Decimal(str(v))), e.opts.get("gender", "m"), e.opts.get("case", "nominative")
            )
        if e.filter == "ordinal":
            return ordinal(
                int(Decimal(str(v))), _bool(e.opts.get("fem"), False), norm_case(e.opts.get("case"))
            )
        if e.filter == "date" or typ == "date":
            raw = v.get("date") if isinstance(v, dict) else v
            cal = (
                (v.get("calendar") if isinstance(v, dict) else None)
                or e.opts.get("calendar")
                or d.get("calendar")
                or "gregorian"
            )
            m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", str(raw))
            if not m:
                ctx.err(e.name, "invalid_date", f"'{e.name}' must be YYYY-MM-DD")
                return placeholder
            r = date_words(int(m[1]), int(m[2]), int(m[3]), cal,
                           gregorian_names=e.opts.get("names", "gulf"),
                           case=e.opts.get("case"),
                           with_day_name=_bool(e.opts.get("day"), True))  # fmt: skip
            part = e.opts.get("part")
            return (
                r.get(f"{part}_words", r["words"]) if part in ("hijri", "gregorian") else r["words"]
            )
    except (TafqeetError, ValueError, InvalidOperation) as exc:
        ctx.err(e.name, "invalid_value", f"'{e.name}': {exc}")
        return placeholder
    # plain rendering by type
    if typ == "money":
        mp = _money_parts(ctx, e.name, e.opts)
        if mp is None:
            return placeholder
        amount, cur = mp
        words = amount_words(amount, cur, adjective=True)["words"]
        return f"{_fmt_figures(parse_amount(amount))} ({words})"
    if typ == "party":
        if not isinstance(v, dict) or not v.get("name"):
            ctx.err(e.name, "invalid_party", f"'{e.name}' needs at least a name")
            return placeholder
        return str(v["name"])
    if typ == "number":
        try:
            return str(Decimal(str(v)))
        except InvalidOperation:
            ctx.err(e.name, "invalid_number", f"'{e.name}' is not a number")
            return placeholder
    if typ == "choice":
        if v not in d["choices"]:
            ctx.err(e.name, "invalid_choice", f"'{e.name}' must be one of {d['choices']}")
            return placeholder
        return str(v)
    return str(v)


def _eval(ast: list[Any], ctx: _Ctx) -> str:
    out: list[str] = []
    for n in ast:
        if isinstance(n, Text):
            out.append(n.value)
        elif isinstance(n, Expr):
            out.append(_render_expr(n, ctx))
        else:
            if n.op is None:
                ok = ctx.present(n.name)
            else:
                same = str(ctx.value(n.name) or "") == n.literal
                ok = same if n.op == "==" else not same
            out.append(_eval(n.then if ok else n.other, ctx))
    return "".join(out)


def render(body: str, vars_: list[dict[str, Any]], values: dict[str, Any]) -> dict[str, Any]:
    """Render a template. Always returns text (unresolved values stay as [[name]]) plus the
    list of validation errors; `ok` is False when anything is missing or invalid."""
    defs_list = normalize_vars(vars_)
    defs = {v["name"]: v for v in defs_list}
    ast = parse(body)
    undefined = sorted(referenced_names(ast) - set(defs))
    if undefined:
        raise TemplateError("undefined variables: " + ", ".join(undefined))
    ctx = _Ctx(defs, values or {})
    # validate supplied values even when not referenced in an executed branch
    extra = sorted(set(values or {}) - set(defs))
    text = _eval(ast, ctx)
    for name in extra:
        ctx.err(name, "unknown_variable", f"'{name}' is not a variable of this template")
    return {"text": text, "ok": not ctx.errors, "errors": ctx.errors}
