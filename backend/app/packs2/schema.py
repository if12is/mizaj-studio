# ruff: noqa: E501
"""`.mizajpack` v2 reading + validation (zip-slip, size limits, sha256, schema). v1 'models'
packs are accepted and normalised."""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any

from app.api.health import VERSION
from app.core import packs as v1
from app.core import security
from app.core.errors import pack_invalid

DATA_KINDS = ("dictionary", "glossary", "templates", "settings")
KINDS = (*DATA_KINDS, "models")
PAYLOAD_FILE = {k: f"{k}.json" for k in DATA_KINDS}
MAX_MEMBERS = 5000
MAX_MANIFEST = 1 << 20
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_MODELS_BYTES = v1.MAX_TOTAL_BYTES
MAX_RATIO = 1000  # uncompressed / compressed, only enforced above 1 MiB
MAX_ENTRIES = 500_000
_CHUNK = 1 << 20


def _ver(s: str) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", s)[:3])


def safe_member(name: Any) -> str:
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise pack_invalid("unsafe file path", {"path": str(name)})
    p = PurePosixPath(name)
    if p.is_absolute() or ".." in p.parts or p.parts[0].endswith(":"):
        raise pack_invalid("path escapes the pack (zip-slip)", {"path": name})
    return name


@dataclass
class Pack:
    manifest: dict[str, Any]
    payloads: dict[str, Any] = field(default_factory=dict)
    model_files: list[dict[str, Any]] = field(default_factory=list)
    path: Path | None = None

    @property
    def kinds(self) -> list[str]:
        return [k for k in KINDS if k in self.payloads or (k == "models" and self.model_files)]


def _str(v: Any, n: int, name: str, required: bool = False) -> str:
    if v is None and not required:
        return ""
    if not isinstance(v, str) or len(v) > n or (required and not v.strip()):
        raise pack_invalid(f"bad field '{name}'")
    return v


def validate_payload(kind: str, data: Any) -> Any:
    """Structural schema check; per-entry semantic checks happen at merge time (as skips)."""
    if not isinstance(data, dict):
        raise pack_invalid(f"{kind}: top level must be an object")
    key = {"dictionary": "entries", "glossary": "entries", "templates": "templates",
           "settings": "settings"}[kind]  # fmt: skip
    body = data.get(key)
    if kind == "settings":
        if not isinstance(body, dict) or len(body) > 1000:
            raise pack_invalid("settings: 'settings' must be an object")
        if not all(
            isinstance(k, str) and isinstance(v, str) and len(v) < 5000 for k, v in body.items()
        ):
            raise pack_invalid("settings: keys and values must be strings")
        return body
    if not isinstance(body, list) or len(body) > MAX_ENTRIES:
        raise pack_invalid(f"{kind}: '{key}' must be a list (max {MAX_ENTRIES})")
    for e in body:
        if not isinstance(e, dict):
            raise pack_invalid(f"{kind}: entries must be objects")
        if kind == "dictionary":
            _str(e.get("word_or_phrase"), 300, "word_or_phrase", True)
            _str(e.get("diacritized_form"), 600, "diacritized_form", True)
        elif kind == "glossary":
            _str(e.get("term"), 300, "term", True)
            _str(e.get("diacritized"), 600, "diacritized", True)
            for f in ("preferred", "definition", "jurisdiction", "source", "note"):
                _str(e.get(f), 5000, f)
            av = e.get("avoid", [])
            if not isinstance(av, list) or not all(isinstance(x, str) for x in av) or len(av) > 100:
                raise pack_invalid("glossary: 'avoid' must be a list of strings")
        else:
            _str(e.get("name"), 300, "name", True)
            _str(e.get("body"), 200_000, "body", True)
            _str(e.get("category"), 300, "category")
            _str(e.get("jurisdiction"), 300, "jurisdiction")
            if not isinstance(e.get("vars", []), list):
                raise pack_invalid("templates: 'vars' must be a list")
    return body


def _read_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo, expect_size: int, limit: int) -> bytes:
    if info.file_size != expect_size or info.file_size > limit:
        raise pack_invalid("size mismatch or file too large", {"path": info.filename})
    if (
        info.file_size > (1 << 20)
        and info.compress_size
        and info.file_size / info.compress_size > MAX_RATIO
    ):
        raise pack_invalid("suspicious compression ratio", {"path": info.filename})
    buf = bytearray()
    try:
        with zf.open(info) as f:
            while chunk := f.read(_CHUNK):
                buf += chunk
                if len(buf) > expect_size:
                    raise pack_invalid("member larger than declared", {"path": info.filename})
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise pack_invalid("corrupt archive member", {"path": info.filename}) from exc
    return bytes(buf)


def read_pack(path: Path) -> Pack:
    path = Path(path)
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise pack_invalid("not a valid zip archive") from exc
    with zf:
        infos = zf.infolist()
        if len(infos) > MAX_MEMBERS:
            raise pack_invalid("too many files in pack")
        security.check_zip(
            zf, max_members=MAX_MEMBERS, max_total=MAX_MODELS_BYTES + MAX_JSON_BYTES * 4,
            max_member=MAX_MODELS_BYTES, max_ratio=MAX_RATIO, error=lambda r: pack_invalid(r),
        )  # fmt: skip
        names: dict[str, zipfile.ZipInfo] = {}
        for i in infos:
            if i.is_dir():
                continue
            safe_member(i.filename)
            if i.filename in names:
                raise pack_invalid("duplicate member name", {"path": i.filename})
            names[i.filename] = i
        mi = names.get(v1.MANIFEST)
        if mi is None:
            raise pack_invalid("manifest.json is missing")
        if mi.file_size > MAX_MANIFEST:
            raise pack_invalid("manifest too large")
        try:
            m = json.loads(zf.read(mi).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
            raise pack_invalid("manifest.json is not valid JSON") from exc
        if not isinstance(m, dict):
            raise pack_invalid("manifest must be an object")
        if m.get("format") == 1:
            v1.read_manifest(zf)  # full v1 validation (models only)
            return Pack(
                {**m, "kind": "models", "schema_version": 1},
                model_files=list(m["files"]),
                path=path,
            )
        if m.get("format") != 2:
            raise pack_invalid("unsupported pack format (need 1 or 2)")
        return _read_v2(zf, m, names, path)


def _read_v2(zf, m: dict[str, Any], names: dict[str, zipfile.ZipInfo], path: Path) -> Pack:
    kind = m.get("kind")
    kinds_decl = kind if isinstance(kind, list) else [kind]
    if kind != "bundle" and not all(k in KINDS for k in kinds_decl):
        raise pack_invalid("unknown pack kind", {"kind": str(kind)})
    for f in ("version", "created_at"):
        if not isinstance(m.get(f), str) or not m[f]:
            raise pack_invalid(f"manifest has no '{f}'")
    if not isinstance(m.get("license"), str) or not m["license"].strip():
        raise pack_invalid("manifest has no license")
    if isinstance(m.get("min_app_version"), str) and _ver(m["min_app_version"]) > _ver(VERSION):
        raise pack_invalid(
            "pack needs a newer app version", {"min_app_version": m["min_app_version"]}
        )
    files = m.get("files")
    if not isinstance(files, list) or not files:
        raise pack_invalid("manifest lists no files")
    declared: set[str] = set()
    pack = Pack(m, path=path)
    total_models = 0
    for f in files:
        if (
            not isinstance(f, dict)
            or not isinstance(f.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-fA-F]{64}", f["sha256"])
        ):
            raise pack_invalid("malformed file entry in manifest")
        if not isinstance(f.get("size"), int) or f["size"] < 0:
            raise pack_invalid("malformed file size in manifest")
        fp, fk = safe_member(f.get("path")), f.get("kind")
        if fk not in KINDS or fp in declared:
            raise pack_invalid("bad or duplicate file entry", {"path": fp})
        if kind != "bundle" and fk not in kinds_decl:
            raise pack_invalid("file kind does not match pack kind", {"path": fp})
        declared.add(fp)
        info = names.get(fp)
        if info is None:
            raise pack_invalid("file listed in manifest is missing", {"path": fp})
        if fk == "models":
            rel = PurePosixPath(fp)
            if rel.parts[0] != "models" or len(rel.parts) < 3:
                raise pack_invalid("model files must live in models/<dir>/...", {"path": fp})
            total_models += f["size"]
            if total_models > MAX_MODELS_BYTES:
                raise pack_invalid("pack is too large")
            pack.model_files.append({**f, "rel": str(PurePosixPath(*rel.parts[1:]))})
            continue
        if fp != PAYLOAD_FILE[fk]:
            raise pack_invalid("unexpected payload file name", {"path": fp})
        data = _read_member(zf, info, f["size"], MAX_JSON_BYTES)
        if hashlib.sha256(data).hexdigest() != f["sha256"].lower():
            raise pack_invalid("sha256 mismatch", {"path": fp})
        try:
            parsed = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise pack_invalid("payload is not valid UTF-8 JSON", {"path": fp}) from exc
        pack.payloads[fk] = validate_payload(fk, parsed)
    extra = set(names) - declared - {v1.MANIFEST}
    if extra:
        raise pack_invalid("file not listed in manifest", {"path": sorted(extra)[0]})
    if pack.model_files:  # verify model hashes by streaming (no full load)
        for f in pack.model_files:
            h = hashlib.sha256()
            info = names[f["path"]]
            if info.file_size != f["size"]:
                raise pack_invalid("size mismatch", {"path": f["path"]})
            try:
                with zf.open(info) as src:
                    while chunk := src.read(_CHUNK):
                        h.update(chunk)
            except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
                raise pack_invalid("corrupt archive member", {"path": f["path"]}) from exc
            if h.hexdigest() != f["sha256"].lower():
                raise pack_invalid("sha256 mismatch", {"path": f["path"]})
    return pack
