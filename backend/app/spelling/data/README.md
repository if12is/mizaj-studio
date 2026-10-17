# Spelling data (Slice 7.9)

| File | What | License |
| :--- | :--- | :--- |
| `ar.aff`, `ar.dic.gz` | **ayaspell** Arabic Hunspell dictionary (hunspell-ar), release **3.5** as packaged by the LibreOffice dictionaries project (`ar/ar.aff`, `ar/ar.dic`). `ar.dic.gz` is `ar.dic` gzip-compressed (`gzip -9 -n`), content unchanged. | GPL-2.0-or-later **or** LGPL-2.1-or-later **or** MPL-1.1+ (tri-license, see `COPYING`). Mizaj Studio uses it under the **LGPL-2.1-or-later / GPL** option, compatible with GPL-3.0-or-later. |
| `COPYING` | the ayaspell tri-license notice (from `linuxscout/ayaspell`) | - |
| `confusables.json` | closed lists for the rule-based error patterns (7.9.2), written for this project | GPL-3.0-or-later |

## Provenance

* Project: ayaspell, <http://ayaspell.sourceforge.net/> (source: <https://github.com/linuxscout/ayaspell>, authors Taha Zerrouki, Mohamed Kebdani and contributors).
* Files fetched from <https://raw.githubusercontent.com/LibreOffice/dictionaries/master/ar/ar.aff> and `.../ar/ar.dic` (LibreOffice package `org.openoffice.ar.hunspell.dictionaries`, version 3.5, packaged by Ahmad Farghal), downloaded 2026-10-17.
* SHA-256 of the **uncompressed** upstream files:
  * `ar.aff`  `cec30b8621001e49618feb05aec1984c5fcfbf7d2ec309901d5cbf66585217a3`
  * `ar.dic`  `2a3e5367f61c1583734db9d66734f5603e6be5c2d227cf5c5cd7e4ca586e34fe`
* SHA-256 of the shipped `ar.dic.gz`: `007a7ad225bd156a3dabf2a33b7a227d99beee9df846d93617dba77d3d9f1a58`.
* Size: `ar.aff` 87 KB, `ar.dic.gz` 1.5 MB (7.2 MB uncompressed, 465,928 lines / 294,182 distinct stems).

## How it is read

`app/spelling/hunspell_lite.py` is a small pure-Python Hunspell affix engine (PFX/SFX, cross
products, suffix continuation classes, AF aliases, ICONV/IGNORE) - no native dependency, so the
PyInstaller build needs nothing extra. It was validated against `spylls` 0.1.7 (MPL-2.0, the
reference pure-Python Hunspell): on 11k probe words it differs on 4 (0.1 %) and all four are
`spylls`-accepts / ours-rejects, i.e. it can only over-report, never miss an error.
`spylls` itself is not shipped: it needs ~600 MB RAM and ~6 s to load this dictionary, ours ~55 MB / ~1 s.

Words are checked after removing tashkeel, dagger alef and tatweel (lookup key only; the text is never changed).
