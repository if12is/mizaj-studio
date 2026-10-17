# Free Arabic legal NLP resources and glossaries (research note, Task 7.10.13)

Status as of this note: **research only. Nothing here is bundled, trained on, or downloaded by
the app.** Licenses below were *not* verified by reading the actual license file unless stated;
"UNVERIFIED" means exactly that. Before any use (evaluation only, never training inside the
product, never user documents), read the license of the file you actually download.
Offline-first rule (AGENTS.md section 5): at most an opt-in download with checksum + shown license.

| Resource | What it is | License status | Notes |
|---|---|---|---|
| ALARB (EMNLP/ArabicNLP 2025, arXiv:2510.00694) | ~13K Saudi commercial-court cases: facts, reasoning, verdicts, cited regulation clauses; verdict prediction / reasoning completion / regulation retrieval | **UNVERIFIED** - search results did not show a license or a Hugging Face card | Check the paper's data-availability section and dataset card |
| Saudi commercial-court judgment prediction set (arXiv:2501.09768, Kmainasi et al. 2025) | Saudi court judgments for legal judgment prediction | **UNVERIFIED**; unclear whether it is the same release as ALARB | Evaluation only |
| Board of Grievances (Diwan al-Mazalim) corpora (~3,170 cases; ~9,699 with summaries, reported in papers) | Administrative judgments | **UNVERIFIED** (authors say "available", terms not confirmed) | Sensitive content: personal data; run redaction first |
| Qatar Al Meezan portal (almeezan.qa) | Legislation (9,000+ instruments), judgments, agreements, Arabic | A 2015 Open Knowledge Index entry said CC-BY on the site, but no bulk download; **terms may have changed - UNVERIFIED** | Site terms govern; scraping not assumed allowed |
| UAE federal open data (Federal Open Data License, u.ae / ministry portals) | Government open data; license permits reuse/modification/redistribution per the UAE Federal Open Data License | License named by ministry pages (reuse allowed); **applicability to each legal text UNVERIFIED** | A Hugging Face mirror of UAE laws (endomorphosis/ipfs_uae_laws) says reuse per source portal terms and is not an official consolidation - treat as unverified third-party mirror |
| Egyptian laws portals (Al-Waqa'i' al-Masriyya, Manshurat Qanuniyya) | Official gazette / laws | **UNVERIFIED**; official texts, redistribution terms unknown | Mizaj ships no legislative text; users maintain `law-index` files themselves |
| Saudi Umm al-Qura / Bureau of Experts (laws.boe.gov.sa) | Official Saudi regulations | **UNVERIFIED** | Same: reference only |
| Arabic legal glossaries (Arab League, WIPO, UN terminology databases e.g. UNTERM, WIPO Pearl) | Multilingual legal/IP terminology | **UNVERIFIED** per database; UN/WIPO have their own reuse terms | Good candidates for the user-imported glossary (7.10.7) after reading terms; the app only stores glossary entries the user imports |
| Tashkeela / Fadel et al. 2019 / SadeedDiac-25 | Diacritized corpora (see Phase 7 plan 7.1.1) | Tashkeela page mentions GPL; others UNVERIFIED | For diacritization evaluation, not legal NLP |

## Recommendations
1. Treat all of these as *evaluation* material only; keep them out of the repo and packs.
2. Record source URL + license text + SHA256 locally at download time (planned in 7.8.3).
3. Court data contains personal data: run `legal/redact.py` suggestions before sharing any sample.
4. Re-verify every "UNVERIFIED" row before relying on it.
