"""Apply the `models` part of a v1/v2 pack (verified again while extracting)."""

from __future__ import annotations

import hashlib
import json
import shutil
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.core import packs as v1
from app.core.errors import pack_invalid
from app.packs2.schema import Pack


def apply_models(pack: Pack, data_dir: Path) -> dict[str, Any]:
    if pack.manifest.get("format") == 1:
        return v1.apply_pack(pack.path, data_dir)
    models = Path(data_dir) / "models"
    models.mkdir(parents=True, exist_ok=True)
    tmp = models / f".tmp-pack-{uuid.uuid4().hex[:10]}"
    try:
        tmp.mkdir()
        with zipfile.ZipFile(pack.path) as zf:
            for f in pack.model_files:
                rel = v1._safe_rel(f["rel"])
                dest = tmp.joinpath(*rel.parts)
                dest.parent.mkdir(parents=True, exist_ok=True)
                h = hashlib.sha256()
                with zf.open(f["path"]) as s, open(dest, "wb") as o:
                    while c := s.read(1 << 20):
                        h.update(c)
                        o.write(c)
                if h.hexdigest() != f["sha256"].lower():
                    raise pack_invalid("sha256 mismatch", {"path": f["path"]})
        v1._swap_in(tmp, models)
        info = {
            "version": str(pack.manifest["version"]),
            "installed_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "files": [{"path": f["rel"], "size": f["size"]} for f in pack.model_files],
        }
        (models / v1.INFO_FILE).write_text(json.dumps(info, indent=2), encoding="utf-8")
        return info
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
