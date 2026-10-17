#!/usr/bin/env python3
"""Print the installed Python distributions (name, version, license) as JSON.

Used by sbom.cjs for the engine's SBOM: it reads importlib.metadata of the interpreter that has
backend/requirements*.txt installed (the one PyInstaller freezes). Reads metadata only.
"""

import json
import re
import sys
from importlib import metadata

CLASSIFIER_LICENSES = {
    "MIT License": "MIT",
    "BSD License": "BSD",
    "Apache Software License": "Apache-2.0",
    "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0",
    "GNU General Public License v3 (GPLv3)": "GPL-3.0-only",
    "GNU General Public License v3 or later (GPLv3+)": "GPL-3.0-or-later",
    "GNU General Public License v2 (GPLv2)": "GPL-2.0-only",
    "GNU General Public License v2 or later (GPLv2+)": "GPL-2.0-or-later",
    "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only",
    "GNU Lesser General Public License v3 or later (LGPLv3+)": "LGPL-3.0-or-later",
    "GNU Library or Lesser General Public License (LGPL)": "LGPL",
    "ISC License (ISCL)": "ISC",
    "Python Software Foundation License": "PSF-2.0",
    "The Unlicense (Unlicense)": "Unlicense",
    "Public Domain": "LicenseRef-PublicDomain",
}


def license_of(md) -> str:
    expr = md.get("License-Expression")
    if expr:
        return expr.strip()
    classifiers = [c.split("::")[-1].strip() for c in md.get_all("Classifier") or [] if c.startswith("License ::")]
    mapped = [CLASSIFIER_LICENSES.get(c, c) for c in classifiers if c != "OSI Approved"]
    if mapped:
        return " OR ".join(dict.fromkeys(mapped))
    lic = (md.get("License") or "").strip()
    if lic and len(lic) <= 80 and "\n" not in lic:
        return lic
    return ""  # unknown (long license text): resolved via exceptions file


def canon(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def requirement_names(path: str) -> list[str]:
    names = []
    for line in open(path, encoding="utf-8"):
        line = line.split("#")[0].strip()
        m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)", line)
        if m and not line.startswith("-"):
            names.append(canon(m.group(1)))
    return names


def runtime_closure(roots: list[str]) -> set[str]:
    """Distributions reachable from the runtime requirements (build tools are excluded)."""
    dists = {canon(d.metadata.get("Name") or ""): d for d in metadata.distributions()}
    seen: set[str] = set()
    todo = list(roots)
    while todo:
        n = todo.pop()
        if n in seen or n not in dists:
            continue
        seen.add(n)
        for req in dists[n].requires or []:
            if "extra ==" in req:  # optional extras are not installed/frozen
                continue
            m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)", req)
            if m:
                todo.append(canon(m.group(1)))
    return seen


def main() -> None:
    only = None
    if "--requirements" in sys.argv:
        only = runtime_closure(requirement_names(sys.argv[sys.argv.index("--requirements") + 1]))
    out = []
    for d in metadata.distributions():
        md = d.metadata
        name = md.get("Name")
        if not name or (only is not None and canon(name) not in only):
            continue
        out.append(
            {
                "name": name,
                "version": d.version,
                "license": license_of(md),
                "homepage": md.get("Home-page") or "",
            }
        )
    out.sort(key=lambda x: x["name"].lower())
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
