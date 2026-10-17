# Mizaj Studio — Brand Identity / الهوية البصرية لمِزَاج

## 1. Concept / الفكرة

**EN.** The mark joins a classic ink-pen nib, pointing up, with a "crown" made of the two Arabic marks that give the app its purpose: the **shadda** (ّ, amber, three scalloped teeth) and above it the **fatha** (َ, emerald, a rising stroke). The nib is writing; the crown is tashkeel. Orthography is respected: the fatha sits above the shadda. The glow behind the crown is a soft amber halo (dropped in the small and monochrome variants). The wordmark «مِزَاج» is fully diacritized, since the diacritics are the brand; its fatha and kasra are emerald, and any shadda would be amber.

**AR.** تجمع العلامة بين سنّ قلم حبر كلاسيكي متجه للأعلى وتاجٍ من الشدّة (ّ، كهرماني، بثلاث أسنان) وفوقها الفتحة (َ، زمردي). السنّ هو الكتابة والتاج هو التشكيل، والفتحة فوق الشدّة كما في الرسم الإملائي. الاسم «مِزَاج» مشكول بالكامل لأن الحركات هي الهوية؛ تُلوَّن الفتحة والكسرة بالزمردي وأي شدّة بالكهرماني.

## 2. Construction, clear space, minimum sizes / البناء والمساحة والحد الأدنى

- Mark grid: 512-unit box; nib 156–356 wide, tip at y≈196, base y≈476; shadda 158–354 at y≈100–166; fatha stroke (186,78)→(326,36). Centered on x=256.
- Clear space: at least the width of the nib's slit hole ×2 → practically **25% of the mark height** on all sides (horizontal logo: the height of the shadda on all sides).
- Minimum sizes: mark ≥ 24 px (use `logo-mark.svg`); below that, use `logo-mark-small.svg` (heavier strokes, bigger slit), down to 16 px. Horizontal logo ≥ 120 px wide; stacked ≥ 80 px; Arabic wordmark ≥ 64 px.
- App icon: rounded-square slate tile (corner radius 21.9%). Sizes ≤ 32 px use `app-icon-small.svg`.

## 3. Color tokens / الألوان

| Token | Hex | RGB | Use |
|---|---|---|---|
| Slate 900 | `#0F172A` | 15,23,42 | night background, text on light |
| Emerald 500 | `#10B981` | 16,185,129 | primary, nib/fatha on dark |
| Amber 500 | `#F59E0B` | 245,158,11 | shadda/highlights on dark |
| Emerald 600 | `#059669` | 5,150,105 | nib/fatha on white (graphic) |
| Amber 600 | `#D97706` | 217,119,6 | shadda on white (graphic) |
| Emerald 700 | `#047857` | 4,120,87 | emerald text on white |
| Amber 700 | `#B45309` | 180,83,9 | amber text on white |
| Slate 600 | `#475569` | 71,85,105 | "Mizaj Studio" on white |
| Slate 400 | `#94A3B8` | 148,163,184 | "Mizaj Studio" on slate |
| Slate 50 | `#F8FAFC` | 248,250,252 | wordmark on slate |

Measured WCAG contrast ratios:

| Pair | Ratio | Verdict |
|---|---|---|
| Emerald 500 on Slate 900 | 7.04:1 | AA/AAA text |
| Amber 500 on Slate 900 | 8.31:1 | AA/AAA text |
| Slate 50 on Slate 900 | 17.06:1 | AAA |
| Slate 400 on Slate 900 | 6.96:1 | AA |
| Slate 900 on White | 17.85:1 | AAA |
| Emerald 700 on White | 5.48:1 | AA text |
| Amber 700 on White | 5.02:1 | AA text |
| Slate 600 on White | 7.58:1 | AAA |
| Emerald 600 on White | 3.77:1 | graphics/large only (>=3:1) |
| Amber 600 on White | 3.19:1 | graphics/large only |
| Emerald 500 on White | 2.54:1 | do not use |
| Amber 500 on White | 2.15:1 | do not use |
| Slate 900 on Emerald 500 | 7.04:1 | AA button text |

## 4. Typography / الخطوط

- UI: **Cairo** SemiBold/Bold. Arabic display and editor: **Amiri** (Bold used for the wordmark). Colored diacritics in the editor use `Amiri-Mizaj-Colr`.
- Wordmark glyphs are vector outlines shaped with HarfBuzz (Amiri Bold for «مِزَاج», Cairo Bold for "Mizaj Studio"); no font is needed to display logo files.
- Amiri and Cairo are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org); embedding outlines in a logo is permitted.

## 5. Do / Don't

Do: use the provided files; keep emerald/amber on slate or white as specified; use the monochrome files for one-color print, stamps, fax; keep marks above the nib.
Don't: recolor the shadda emerald or the fatha amber; stretch or rotate; add shadows/outlines; place the full-color mark on mid-tone or busy backgrounds; use Emerald/Amber 500 on white; retype the name in a live font; remove the diacritics from «مِزَاج».

## 6. License / الترخيص

The logo assets are part of the GPL-3.0 project and may be used with it. **Recommendation:** release the brand assets in this folder under **CC BY-SA 4.0** (logos are artwork, not software; GPL is awkward for images), with the extra request that modified versions must not imply being the official Mizaj Studio. The OFL fonts keep their own license.

## 7. File index / فهرس الملفات

Suffixes: none = for white/light backgrounds; `-dark` = for slate/dark backgrounds; `-mono` = single color slate; `-mono-white` = single color white. All transparent.

- `logo-mark[-dark|-mono|-mono-white].svg`, `logo-mark-small[...].svg` (16–24 px)
- `logo-full-horizontal[...].svg`, `logo-full-stacked[...].svg`, `wordmark-ar[...].svg`
- `app-icon.svg`, `app-icon-small.svg` (slate tile), `banner-1280x640.svg`, `splash-800x450.svg`
- `png/icon-{16,24,32,48,64,128,256,512,1024}.png`, `png/mark-*.png`, `png/banner-1280x640.png`, `png/splash-800x450.png`, `png/logo-*.png`, `png/wordmark-*.png`
- `mizaj.ico` (16, 24, 32, 48, 64, 128, 256; PNG-encoded)
- `preview.html`, `preview.png`
- App copies: `desktop/build/icon.svg`, `icon.png` (1024), `icon.ico`.
