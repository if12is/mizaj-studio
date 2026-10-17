# Free public Arabic NLP APIs - evaluation only (Task 7.8.5)

Status: **nothing here is integrated**. Mizaj Studio sends no text to any remote service
(AGENTS.md section 5). A remote API would only ever be an opt-in "second opinion" that shows,
before the first call, exactly which text leaves the device. Facts below come from the
maintainers' public descriptions as known when this was written and **must be re-verified
against the live terms before any adoption** (the build environment had no access to these hosts).

| Candidate | What it offers | License / terms | Privacy | Verdict |
| :-- | :-- | :-- | :-- | :-- |
| LanguageTool public API (api.languagetool.org) | Grammar/spell check, Arabic rules | Software LGPL-2.1+; the hosted API is free with rate limits (about 20 requests/min, 20 KB/request) under its own ToS | Text is sent to a third-party server and processed there; their policy says it is not stored beyond processing, unverified by us | **Reject as built-in.** The same engine runs locally (7.9.4, loopback), which is the supported route |
| Farasa API (QCRI) | Segmentation, POS, diacritization | Research/academic license; commercial use restricted; Farasa software is not GPL-compatible as far as we know | Text leaves the device | **Reject** (license + privacy) |
| Mishkal web service (tashkeel.org) | Online tashkeel | Mishkal code is GPL-3.0 (already bundled offline) | Text leaves the device | **Reject**: the library is already used offline |
| SinaTools / Birzeit APIs | Arabic NLP (NER, lemmatization, diacritization) | Free for research; terms of the hosted API unclear | Text leaves the device | **Reject** until terms are verified; revisit as an offline library if its license is GPL-compatible |
| Quran.com API v4 | Quran text/translations | Content under Tanzil/Quran Foundation terms | Only verse references are sent, no user text | **Not needed**: Quran text is downloaded once as a file (Tanzil, CC BY 3.0, verbatim) and cached offline (7.8.3) |
| Tanzil downloads | Quran text file | CC BY 3.0, text must stay verbatim, attribution required | File download only | **Adopt as a resource download**, not an API (catalog.json) |
| Google/Azure/AWS NLP, OpenAI-style hosted LLMs | General NLP | Commercial, account required | Text leaves the device | **Reject**: accounts and paid terms violate the no-accounts rule |

## Rules for any future remote call

1. Opt-in per feature, off by default, with the data that leaves the device shown first.
2. Every outbound request goes through `app/resources/net.py` (host allowlist + logging).
3. The result is a suggestion only; `strip_marks(out) == strip_marks(in)` is enforced before it is shown.
4. A working offline fallback must exist.
