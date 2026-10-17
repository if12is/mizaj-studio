# Gold set provenance

All sentences in `*.txt` here are **original text written and diacritized by the Mizaj Studio
project** for evaluation purposes, and are licensed **GPL-3.0-or-later** (same as the project;
they may also be reused under CC0 by anyone who prefers). No third-party corpus text is
included, and **no Quran or other scripture** is used.

| File | Domain | Sentences |
| :--- | :--- | ---: |
| `general.txt` | everyday MSA prose | 57 |
| `news.txt` | news-style MSA | 35 |
| `legal.txt` | contract / legal phrasing | 35 |
| `letters.txt` | official-letter phrasing | 25 |

Conventions: full case endings (not pausal); `الْ` with sukun on lam and shadda on a following sun
letter; tanween fatha on the letter before a final alef; long vowels unmarked; hamzat-wasl alef
unmarked; hamza forms carry their vowel (`إِلَى`, `أَنَّ`); dagger alef omitted (`هَذَا`).

The set is small (about 956 words), so differences below ~1 DER point between engines are noise.
Each sentence was checked by hand and then cross-checked against the CATT model: every
disagreement between gold and CATT was reviewed individually (CATT errors were kept as errors;
only genuine gold mistakes were corrected). For publication-grade numbers evaluate on an external
corpus: `python scripts/eval_tashkeel.py --corpus /path/to/tashkeela --max-lines 500`
(Tashkeela / Fadel format: UTF-8 text, one fully diacritized line per line; never committed).
