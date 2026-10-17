#!/usr/bin/env python3
"""Build the three domain `.mizajpack` v2 files (Task 7.4.4) with the app's own export logic.

    python scripts/build_domain_packs.py                       # writes resources/packs/*.mizajpack
    python scripts/build_domain_packs.py --version 0.2.0       # also points catalog.json at v0.2.0
    python scripts/build_domain_packs.py --check               # fail if committed packs are stale

Sources (CC0 1.0, authored for Mizaj Studio) live in scripts/domain_data/*.tsv; the legal pack also
contains the bundled legal glossary (backend/app/legal/data/glossary.json). The output is byte
deterministic (fixed timestamps), so the sha256 values in app/resources/catalog.json only change
when the data changes. Release assets are named exactly like the files in resources/packs.
"""

# ruff: noqa: E501
from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
DATA = ROOT / "scripts" / "domain_data"
OUT = ROOT / "resources" / "packs"
CATALOG = BACKEND / "app" / "resources" / "catalog.json"
REPO = "if12is/mizaj-studio"
PACK_VERSION = "1.0.0"
MIN_APP = "0.1.0"  # fixed so the packs stay byte-stable across app releases
ZIP_DATE = (2026, 1, 1, 0, 0, 0)
LICENSE = "CC0-1.0"
LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/"

PACKS = {
    "mizaj-legal-terms": {
        "file": "mizaj-legal-terms.mizajpack",
        "kinds": ["glossary"],
        "name": "Mizaj legal terms (contracts and courts)",
        "name_ar": "مصطلحات قانونية (عقود ومحاكم)",
        "description": "Diacritized legal glossary: the bundled legal terms plus contract and court terminology.",
    },
    "mizaj-names-eg-gulf-levant": {
        "file": "mizaj-names-eg-gulf-levant.mizajpack",
        "kinds": ["dictionary"],
        "name": "Egyptian, Gulf and Levantine names and places",
        "name_ar": "أسماء وأماكن (مصر والخليج والشام)",
        "description": "Common given names and place names with full vowels, for the user dictionary.",
    },
    "mizaj-official-phrases": {
        "file": "mizaj-official-phrases.mizajpack",
        "kinds": ["glossary"],
        "name": "Official correspondence phrases",
        "name_ar": "عبارات المراسلات الرسمية",
        "description": "Salutations, honorifics and stock phrases of official letters, diacritized.",
    },
}


def read_tsv(name: str) -> list[list[str]]:
    rows = []
    for line in (DATA / name).read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            rows.append(line.split("\t"))
    return rows


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    ap.add_argument(
        "--version", help="release version for the catalog URLs (default: app VERSION)"
    )
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument(
        "--no-catalog", action="store_true", help="do not touch catalog.json"
    )
    ap.add_argument(
        "--check", action="store_true", help="exit 1 when the packs on disk differ"
    )
    args = ap.parse_args()

    sys.path.insert(0, str(BACKEND))
    from app.api.health import VERSION
    from app.core.database import connect
    from app.core.migrations import run_migrations
    from app.engine.normalize import strip_marks
    from app.packs2 import export as ex

    version = args.version or VERSION
    ex.VERSION = MIN_APP  # app_version / min_app_version recorded in the manifests

    class _Fixed:
        @staticmethod
        def now(_tz=None):
            import datetime as dt

            return dt.datetime(2026, 1, 1, tzinfo=dt.UTC)

    ex.datetime = _Fixed  # type: ignore[assignment]

    legal_builtin = json.loads(
        (BACKEND / "app/legal/data/glossary.json").read_text("utf-8")
    )
    sources = {
        "mizaj-legal-terms": [
            (e["term"], e["diacritized"], "Mizaj Studio (CC0)")
            for e in legal_builtin["entries"]
        ]
        + [(r[0], r[1], "Mizaj Studio (CC0)") for r in read_tsv("legal_extra.tsv")],
        "mizaj-names-eg-gulf-levant": [
            (r[0], r[1], r[2]) for r in read_tsv("names.tsv")
        ],
        "mizaj-official-phrases": [
            (r[0], r[1], "Mizaj Studio (CC0)") for r in read_tsv("phrases.tsv")
        ],
    }

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    built: dict[str, dict] = {}
    stale = False
    for pid, spec in PACKS.items():
        rows, seen = [], set()
        for term, dia, src in sources[pid]:
            term = " ".join(term.split())
            dia = " ".join(dia.split())
            if strip_marks(dia) != term:
                raise SystemExit(
                    f"[ERROR] {pid}: letters differ for '{term}' -> '{dia}'"
                )
            if term in seen:
                raise SystemExit(f"[ERROR] {pid}: duplicate term '{term}'")
            seen.add(term)
            rows.append((term, dia, src))
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "t.db"
            run_migrations(db_path, Path(td) / "bk")
            db = connect(db_path)
            for term, dia, src in rows:
                if spec["kinds"] == ["dictionary"]:
                    db.execute(
                        "INSERT INTO tashkeel_cache(word_or_phrase,diacritized_form,source,is_user_locked)"
                        " VALUES(?,?,'dictionary',1)",
                        (term, dia),
                    )
                else:
                    db.execute(
                        "INSERT INTO legal_glossary(term,diacritized,preferred,source) VALUES(?,?,?,?)",
                        (term, dia, term, src),
                    )
            tmp = Path(td) / spec["file"]
            ex.export_pack(
                db,
                tmp,
                spec["kinds"],
                name=spec["name"],
                version=PACK_VERSION,
                license=LICENSE,
                author="Mizaj Studio contributors",
                attribution="CC0 1.0: no rights reserved.",
                description=spec["description"],
            )
            db.close()
            # Re-pack with fixed timestamps and a stable member order for reproducible bytes.
            buf = io.BytesIO()
            with zipfile.ZipFile(tmp) as zin, zipfile.ZipFile(
                buf, "w", zipfile.ZIP_DEFLATED
            ) as zo:
                for n in sorted(
                    zin.namelist(), key=lambda s: (s != "manifest.json", s)
                ):
                    zi = zipfile.ZipInfo(n, ZIP_DATE)
                    zi.compress_type = zipfile.ZIP_DEFLATED
                    zi.external_attr = 0o644 << 16
                    zo.writestr(zi, zin.read(n))
        data = buf.getvalue()
        target = out_dir / spec["file"]
        if args.check:
            if not target.exists() or target.read_bytes() != data:
                print(f"[STALE] {target}")
                stale = True
        else:
            target.write_bytes(data)
        built[pid] = {"file": spec["file"], "sha256": sha256_bytes(data), "size": len(data),
                      "entries": len(rows)}  # fmt: skip
        print(
            f"[OK] {spec['file']}  {len(rows)} entries  {len(data)} bytes  {built[pid]['sha256']}"
        )

    if args.check:
        return 1 if stale else 0
    if not args.no_catalog:
        cat = json.loads(CATALOG.read_text(encoding="utf-8"))
        keep = [r for r in cat["resources"] if r.get("kind") != "mizajpack"]
        for pid, spec in PACKS.items():
            b = built[pid]
            keep.append(
                {
                    "id": pid,
                    "name": spec["name"],
                    "kind": "mizajpack",
                    "url": f"https://github.com/{REPO}/releases/download/v{version}/{b['file']}",
                    "filename": b["file"],
                    "sha256": b["sha256"],
                    "size": b["size"],
                    "license": LICENSE,
                    "license_url": LICENSE_URL,
                    "attribution": "Mizaj Studio contributors (CC0 1.0)",
                    "notes": "Domain pack (.mizajpack v2). Downloaded from the matching GitHub "
                    "release; import it from the packs screen. Needs expert review before "
                    "professional use.",
                }
            )
        cat["resources"] = keep
        CATALOG.write_text(
            json.dumps(cat, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        print(f"[OK] catalog updated ({CATALOG}) for v{version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
