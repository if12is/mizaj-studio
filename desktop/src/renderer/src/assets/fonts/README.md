# Amiri-Mizaj-Colr.woff2

Amiri (SIL OFL 1.1) with OpenType `COLR` v0 + `CPAL` tables. Family name:
**`Amiri Mizaj Colr`**.

- All 62 Arabic combining-mark glyphs (GDEF class 3: U+0610-061A, U+064B-065F,
  U+0670, U+06D6-06ED and their GSUB alternates) have a COLR layer
  `[(glyph, paletteEntry)]`. Base glyphs have no COLR entry, so they render with
  the text colour (dark/light theme works).
- CPAL entry 0 = mark colour, entry 1 = shadda (U+0651) colour.
  - palette 0 (emerald): `#10B981`, `#F59E0B`
  - palette 1 (amber): `#F59E0B`, `#F59E0B`
- GSUB / GPOS / GDEF / glyf / cmap / hmtx are untouched: shaping and mark
  positioning are identical to the source. Text width is identical in all palettes.
- Source: `@fontsource/amiri` 5.0.8 `amiri-arabic-400-normal.woff2`
  (SHA256 `0d23e3fc...348d`, from https://github.com/aliftype/amiri).
- Licence: `OFL.txt`. Amiri declares no Reserved Font Name, so the derived
  family name is permitted.

## CSS behaviour (verified in Chromium)

`font-palette: normal` is NOT "off": a COLR font always paints palette 0, so marks
are emerald. To switch colouring off with this font you must override the
entries to the text colour, or use the plain Amiri face:

```css
@font-palette-values --mizaj-colored {
  font-family: 'Amiri Mizaj Colr';
  base-palette: 0;
}
@font-palette-values --mizaj-amber {
  font-family: 'Amiri Mizaj Colr';
  base-palette: 1;
}
/* "off": explicit colours (currentcolor in override-colors is not honoured) */
@font-palette-values --mizaj-off {
  font-family: 'Amiri Mizaj Colr';
  base-palette: 0;
  override-colors:
    0 #1f2937,
    1 #1f2937;
}
```

For dark mode define a second `--mizaj-off-dark` with light colours, or fall back
to the plain `@fontsource/amiri` family when the toggle is off.

## Regenerate

```
python3 -m venv .venv && .venv/bin/pip install -r scripts/requirements-fonts.txt
.venv/bin/python scripts/build_colr_font.py [--input FONT] [--no-verify]
```
