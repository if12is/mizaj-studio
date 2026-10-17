#!/usr/bin/env python3
"""Build Amiri-Mizaj-Colr.woff2: Amiri with COLRv0 + CPAL colored diacritics.

Source font (SIL OFL 1.1, Amiri Project Authors): the Arabic subset woff2 of
@fontsource/amiri 5.0.8 (npm, derived from https://github.com/aliftype/amiri),
which contains all Arabic letters/marks plus intact GSUB/GPOS/GDEF.
    SHA256 0d23e3fcdadc995db12650b30c3dcdedafc57e8daf4fbd016b6dae17bc59348d
(The official GitHub release can be passed instead with --input and
--no-verify; any input works as long as it is Amiri.)

Usage:
    pip install -r scripts/requirements-fonts.txt
    python scripts/build_colr_font.py [--input FONT] [--output OUT.woff2] [--no-verify]

Design:
  * every GDEF class-3 (mark) glyph that is an Arabic mark gets a COLR layer
    list [(itself, palette entry)]; base glyphs get none -> currentColor.
  * CPAL entry 0 = mark colour, entry 1 = shadda colour.
    palette 0 (emerald): #10B981 / #F59E0B ; palette 1 (amber): #F59E0B / #F59E0B
  * GSUB/GPOS/GDEF are untouched (byte-identical); only COLR, CPAL and name change.
  * Family renamed "Amiri Mizaj Colr". Amiri's license header declares no
    Reserved Font Name, so the name is permitted; OFL.txt ships beside the font.
"""
import argparse, hashlib, sys
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.colorLib.builder import buildCOLR, buildCPAL

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IN = ROOT / "desktop/node_modules/@fontsource/amiri/files/amiri-arabic-400-normal.woff2"
DEFAULT_OUT = ROOT / "desktop/src/renderer/src/assets/fonts/Amiri-Mizaj-Colr.woff2"
SRC_SHA256 = "0d23e3fcdadc995db12650b30c3dcdedafc57e8daf4fbd016b6dae17bc59348d"
FAMILY, PS_NAME = "Amiri Mizaj Colr", "AmiriMizajColr-Regular"

def rgba(h, a=1.0):
    return tuple(int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)) + (a,)
EMERALD, AMBER = rgba("#10B981"), rgba("#F59E0B")

def is_arabic_mark(cp):
    return 0x0610 <= cp <= 0x061A or 0x064B <= cp <= 0x065F or cp == 0x0670 or 0x06D6 <= cp <= 0x06ED

def gsub_closure(font, seeds):
    """Glyphs reachable from seeds via single/alternate/ligature-result GSUB."""
    found, todo = set(seeds), list(seeds)
    subs = []
    for l in font["GSUB"].table.LookupList.Lookup:
        for st in l.SubTable:
            subs.append(getattr(st, "ExtSubTable", st))
    while todo:
        g = todo.pop()
        outs = set()
        for st in subs:
            m = getattr(st, "mapping", None)
            if isinstance(m, dict) and g in m:
                outs |= set(m[g]) if isinstance(m[g], (list, tuple)) else {m[g]}
            alt = getattr(st, "alternates", None)
            if isinstance(alt, dict):
                outs |= set(alt.get(g, []))
        for o in outs:
            if o and o not in found:
                found.add(o); todo.append(o)
    return found

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=DEFAULT_IN)
    ap.add_argument("--output", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--no-verify", action="store_true", help="skip SHA256 check of the input")
    a = ap.parse_args()
    if not a.input.is_file():
        sys.exit(f"input font not found: {a.input} (run npm install in desktop/ or pass --input)")
    if not a.no_verify:
        h = hashlib.sha256(a.input.read_bytes()).hexdigest()
        if h != SRC_SHA256:
            sys.exit(f"SHA256 mismatch for {a.input}: {h} != {SRC_SHA256} (use --no-verify for another Amiri build)")

    # Analysis copy: reading GSUB/GDEF decompiles them, and fontTools would then
    # re-serialise them on save. Keep them untouched in `font` (byte-identical).
    probe = TTFont(a.input)
    font = TTFont(a.input)
    cmap = probe.getBestCmap()
    gdef = probe["GDEF"].table
    mark_glyphs = {g for g, c in gdef.GlyphClassDef.classDefs.items() if c == 3}
    arabic_marks = {cmap[c] for c in cmap if is_arabic_mark(c) and cmap[c] in mark_glyphs}
    arabic_marks = {g for g in gsub_closure(probe, arabic_marks) if g in mark_glyphs}
    shadda = {g for g in gsub_closure(probe, {cmap[0x0651]}) if g in mark_glyphs}

    order = font.getGlyphOrder()
    colr = {g: [(g, 1 if g in shadda else 0)] for g in order if g in arabic_marks}
    font["COLR"] = buildCOLR(colr, version=0, glyphMap=font.getReverseGlyphMap())
    font["CPAL"] = buildCPAL([[EMERALD, AMBER], [AMBER, AMBER]],
                             paletteLabels=None, paletteEntryLabels=None)

    name = font["name"]
    for rec in list(name.names):
        if rec.nameID in (1, 3, 4, 6, 16, 17, 21, 22):
            name.removeNames(nameID=rec.nameID, platformID=rec.platformID)
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        for nid, val in ((1, FAMILY), (2, "Regular"), (3, "Mizaj Studio;" + PS_NAME),
                         (4, FAMILY), (6, PS_NAME), (16, FAMILY), (17, "Regular")):
            if nid != 2:  # subfamily (ID 2) is kept as-is
                name.setName(val, nid, pid, eid, lid)
    font.flavor = "woff2"
    a.output.parent.mkdir(parents=True, exist_ok=True)
    font.save(a.output)
    print(f"wrote {a.output} ({a.output.stat().st_size} bytes): {len(colr)} colored mark glyphs "
          f"({len(shadda)} shadda), family '{FAMILY}'")

if __name__ == "__main__":
    main()
