# Amiri-Mizaj-Colr.woff2 (NOT YET GENERATED)

This folder must contain `Amiri-Mizaj-Colr.woff2`, an Amiri build with OpenType
`COLR` v0 + `CPAL` tables where the combining marks (fatha, damma, kasra, shadda,
sukun, tanween U+064B-U+0652) are layered glyphs using CPAL palette entry 0
(and entry 1 for shadda), and base glyphs use the foreground colour (0xFFFF).

The binary could not be produced in Phase 1 (no font tooling in the build
environment) and is intentionally NOT fabricated. Until it exists the app falls
back to the plain bundled `@fontsource/amiri` font: everything works, the
"colored diacritics" toggle just has no visible effect (the CSS
`font-palette: --mizaj-colored` is ignored by fonts without CPAL).

## How to generate (fonttools)

1. `pip install fonttools brotli ufo2ft`
2. Get Amiri source (OFL): https://github.com/alif-type/amiri
3. Build a layered glyph set: for each mark glyph create a colour layer glyph
   (`<mark>.colr`) and map it with `fontTools.colorLib.builder.buildCOLR`
   (`{ "fatha": [("fatha.colr", 0)], ... }`) and `buildCPAL([[emerald, amber]])`
   with palette 0 = `#10B981`, entry 1 = `#F59E0B`. Base letters stay uncoloured.
4. Insert the tables: `font["COLR"] = buildCOLR(...)`, `font["CPAL"] = buildCPAL(...)`.
5. Rename family to `Amiri Mizaj Colr`, save, then
   `python -c "from fontTools.ttLib import TTFont; f=TTFont('out.ttf'); f.flavor='woff2'; f.save('Amiri-Mizaj-Colr.woff2')"`.
6. Drop the file here. No code change needed: `main.css` already declares
   `@font-face 'Amiri Mizaj Colr'` and `@font-palette-values --mizaj-colored`.
