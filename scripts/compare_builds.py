#!/usr/bin/env python3
"""Compare two builds file by file (Task 7.6.6, see docs/guides/reproducible-builds.md).

    python scripts/compare_builds.py build_a/ build_b/          # two directory trees
    python scripts/compare_builds.py a.exe b.exe                # two single files
    python scripts/compare_builds.py a/ b/ --json diff.json --expect-identical

Every file is hashed (SHA-256). Zip-like containers (.zip .docx .jar .whl .nupkg) are
also compared member by member, with the member timestamps reported separately, because
timestamps are the usual remaining source of differences. Exit code: 0 when identical (or when
--expect-identical is not given), 1 when --expect-identical is given and anything differs,
2 on usage errors.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ZIP_EXT = {".zip", ".jar", ".whl", ".docx", ".xlsx", ".pptx", ".nupkg", ".mizajpack"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def tree(root: Path) -> dict[str, Path]:
    if root.is_file():
        return {root.name: root}
    return {
        p.relative_to(root).as_posix(): p
        for p in sorted(root.rglob("*"))
        if p.is_file() and not p.is_symlink()
    }


def zip_members(path: Path) -> dict[str, tuple[str, tuple[int, ...]]] | None:
    try:
        with zipfile.ZipFile(path) as zf:
            return {
                i.filename: (hashlib.sha256(zf.read(i)).hexdigest(), tuple(i.date_time))
                for i in zf.infolist()
                if not i.is_dir()
            }
    except (zipfile.BadZipFile, OSError):
        return None


def compare(a: Path, b: Path) -> dict:
    ta, tb = tree(a), tree(b)
    if a.is_file() and b.is_file():  # compare two single files whatever they are called
        ta, tb = {"<file>": a}, {"<file>": b}
    only_a = sorted(set(ta) - set(tb))
    only_b = sorted(set(tb) - set(ta))
    same, differ = [], []
    for name in sorted(set(ta) & set(tb)):
        pa, pb = ta[name], tb[name]
        if pa.stat().st_size == pb.stat().st_size and sha256(pa) == sha256(pb):
            same.append(name)
            continue
        entry: dict = {
            "file": name,
            "size_a": pa.stat().st_size,
            "size_b": pb.stat().st_size,
        }
        if pa.suffix.lower() in ZIP_EXT:
            ma, mb = zip_members(pa), zip_members(pb)
            if ma is not None and mb is not None:
                entry["members_only_a"] = sorted(set(ma) - set(mb))
                entry["members_only_b"] = sorted(set(mb) - set(ma))
                both = set(ma) & set(mb)
                entry["members_content_differ"] = sorted(
                    n for n in both if ma[n][0] != mb[n][0]
                )
                entry["members_timestamp_only"] = sorted(
                    n for n in both if ma[n][0] == mb[n][0] and ma[n][1] != mb[n][1]
                )
        differ.append(entry)
    return {
        "a": str(a),
        "b": str(b),
        "identical_files": len(same),
        "different_files": differ,
        "only_in_a": only_a,
        "only_in_b": only_b,
        "identical": not (differ or only_a or only_b),
    }


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawTextHelpFormatter
    )
    ap.add_argument("a", type=Path)
    ap.add_argument("b", type=Path)
    ap.add_argument("--json", type=Path, help="write the full report here")
    ap.add_argument("--expect-identical", action="store_true")
    args = ap.parse_args()
    for p in (args.a, args.b):
        if not p.exists():
            print(f"[ERROR] not found: {p}", file=sys.stderr)
            return 2
    rep = compare(args.a, args.b)
    print(f"identical files: {rep['identical_files']}")
    for n in rep["only_in_a"]:
        print(f"only in A: {n}")
    for n in rep["only_in_b"]:
        print(f"only in B: {n}")
    for d in rep["different_files"]:
        print(f"DIFF {d['file']}  ({d['size_a']} vs {d['size_b']} bytes)")
        if "members_content_differ" in d:
            for k, label in (
                ("members_content_differ", "content"),
                ("members_timestamp_only", "timestamp only"),
                ("members_only_a", "only in A"),
                ("members_only_b", "only in B"),
            ):
                if d[k]:
                    print(
                        f"    {label}: {', '.join(d[k][:8])}{' ...' if len(d[k]) > 8 else ''}"
                    )
    print("RESULT:", "identical" if rep["identical"] else "different")
    if args.json:
        args.json.write_text(
            json.dumps(rep, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    return 1 if (args.expect_identical and not rep["identical"]) else 0


if __name__ == "__main__":
    sys.exit(main())
