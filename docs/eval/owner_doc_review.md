# Owner document review (Egyptian State Litigation Authority defense memo)

Engine: CATT accurate + morph filter v2, level `full`. Authoritative gold: the owner's hand-diacritized
version of the same document (3304 Arabic words, word-for-word aligned with the input). Marks are compared
per letter after canonical mark order (shadda first); hamza spelling differences are base-letter changes and
are out of scope here (suggestions belong to the proofreading module).

## Numbers (owner doc, all 15252 letters)

| | DER | WER | WER w/o case ending | DER w/o case ending |
| :--- | ---: | ---: | ---: | ---: |
| engine alone | 5.28 | 17.80 | 9.20 | 3.61 |
| + `legal_fix` (this change) | 1.89 | 6.63 | 2.63 | 1.12 |

Eval harness (`python -m eval.run_eval`, `accurate+mf2` -> `accurate+mf2+fixes`):

| set | DER before | DER after | WER before | WER after |
| :--- | ---: | ---: | ---: | ---: |
| original gold (152 sentences, general/legal/letters/news) | 3.26 | 2.73 | 12.55 | 10.04 |
| + owner gold (191 sentences; owner_legal alone 6.75 -> 1.18) | 4.57 | 2.15 | 16.47 | 8.08 |

No category regressed (general 3.03->2.33, legal 2.82->2.41, letters 3.27->2.80, news 3.99->3.48).

## Error classes found and fixed (wrong -> correct, rule)

1. Tanween on the first term of an idafa / before a number: `رَقْمٌ 624` -> `رَقْمِ 624`, `بِتَارِيخٍ 8/2/2025` -> `بِتَارِيخِ`, `طَبْعَةُ 1989` -> `طَبْعَةِ`. Rule: a noun directly followed by a figure in `رقم/تاريخ/سنة/جلسة/طبعة` is a mudaf; `رقم` agrees with the previous noun (badal), `الطَّعْنُ رَقْمُ`.
2. `سنة`: `لِسُنَّةِ / لِسُنَةِ / لِسْنَّةِ / لِسَنَةٍ` -> `لِسَنَةِ` (after ل or a figure).
3. Tanween + definite genitive complement: `قَلَمٌ الْكِتَابِ` -> `قَلَمُ`; relational heads (`فَرْعٌ دَمَنْهُورٌ`, `مَحْكَمَةٌ ابُو`) lose tanween.
4. Nominative/accusative after a preposition or idafa head: `إلَى قَلَمُ`, `حَتَّى تَارِيخُ`, `بَعْدَ/عِنْدَ/ضِدَّ/دُونَ ...` -> genitive (hard grammatical constraint; diptote-safe).
5. Coordination: `الْقَضَائِيَّةِ وَرُسُومُ التَّوْثِيقِ`, `النِّسْبِيَّةِ وَالْخِدْمَاتُ` -> genitive.
6. Sukun before hamzat wasl: `مِنْ الْ` -> `مِنَ`, `عَنِ`, `أَوِ`, `قَدِ`, feminine past `أَصْدَرَتِ الْ`.
7. Article alef with a vowel: `وَاَلَّتِي`, `اَلْعَامِّ` -> `وَالَّتِي`; doubled tanween on alef repaired.
8. Initial hamza-below without kasra (`إلَّا إذَا إنَّ إصْدَارِ`, ~40 words) -> `إِ`; the abbreviation `صَ` -> `ص`.
9. Typed-ى/ي prepositions and names: `عَلِيَّ` (read as the name) -> `عَلَي`; `وَفَى هَذَا` -> `وَفِى`; `المدعي عليه` -> `الْمُدَّعَى` (passive) vs the plaintiff `الْمُدَّعِى`.
10. Nisba shadda and case on written ى: `نِسْبِى مُدَنَى كُلَى الِاجْمَالَى` -> `نِسْبِىٌّ مَدَنِىٌّ كُلِّىٌّ الْإِجْمَالِىُّ` (nominative after a figure / كان, genitive after a preposition, second nisba agrees).
11. Currency tamyiz: `جُنَيْهٌ / جَنَيْهَ / جَنَيْهْ` -> `جُنَيْهٍ`.
12. Lexicon (frequent legal words): `مُحْكَمَةٌ`->`مَحْكَمَةُ`, `مُذَكَّرَةٌ`->`مُذَكِّرَةٌ`, `جِلْسَةُ`->`جَلْسَةُ`, `النُّقْضِ`->`النَّقْضِ`, `قُفْلِ بَابِ`->`قَفْلِ بَابِ`, `قَلَمِ الْكِتَابِ`->`الْكُتَّابِ`, `الْمُحَدِّدُ`->`الْمُحَدَّدُ`, `الْمُسْتَبْدِلَةِ`->`الْمُسْتَبْدَلَةِ`, `وَقَدَّرَهُ`->`وَقَدْرُهُ`, `كُرْسُومٍ`->`كَرُسُومٍ`, `كَمُقَدِّمٍ`->`كَمُقَدَّمٍ`, `وَأَرْجَأُ`->`وَأَرْجَأَ`, `خَلَوْا`->`خِلْوًا`, `مُهَيِّئًا`->`مُهَيَّئًا`, `أَنَّهَتْ`->`أَنْهَتْ`, `صَدَّرَ`->`صَدَرَ`, `أَبُو حِمْصَ`->`أَبُو حُمُّص`, `خِدْمَاتٌ`->`خَدَمَات`, `ما سلف`, `دَخَلَ فِي`->`دَخْلٌ فِي`.
13. Passive in legal set phrases: `يَلْزَمُ بِ`/`يُلْزِمَ الْمُدَّعِي بِ` -> `يُلْزَمُ`, `أَعْلَنَتْ بِأَمْرِ` -> `أُعْلِنَتْ`, `مَنْ حَكَمَ عَلَيْهِ` -> `حُكِمَ`, `وَيُعْلِنُ هَذَا الْأَمْرُ` -> `يُعْلَنُ`.
14. Dual construct: `امْرِى تَقْدِيرُ` -> `أَمْرَيِ التَّقْدِيرِ` (kasra before ال) / `أَمْرَىْ تَقْدِيرِ`.
15. `بِأَنْ:` before a quotation -> `بِأَنَّ`; `وَبَانَ :` -> `وَبِأَنَّ`; `انْهَا` -> shadda.
16. Names/titles/lists: `السَّيِّدِ/ رَانِيًا يُوسُفُ مَحْمُودٌ سَلِيمٌ` -> `رَانْيَا يُوسُفِ مَحْمُودِ سَلِيمٍ` (title case copied, idafa chain); `الثَّانِى وَالثَّالِثُ ( السَّيِّدُ / رَئِيسُ ... ، مُعَاوِنٌ أَوَّلَ ...)` -> genitive.
17. Feminine adjective agreement after a preposition + noun, court adjective (`بِمَحْكَمَةِ ... الْكُلِّيَّةُ`), `غَيْرَ مَقْبُولِ` -> tanween, `مَحَلَّ/مَحَلُّ التَّدَاعِي` -> `مَحَلِّ`, `مُشَارِ إِلَيْهِ` (tanween), single-word headings nominative.

## Remaining known errors (about 7% WER)

* Syntax the engine needs real parsing for: `أَيُّ/وَأَيُّ` after `أَوْ/وَ` (should be `أَيِّ`), `الْمَرْكَزَ` coordinated with `الْحَقِّ`, `مُوَاطِنَ` after `كُلِّ`, `قَلَمُ` in apposition (`الْجِهَةِ ... قَلَمِ`), `الصَّادِرُ` modifying a genitive, `الدَّفْعَ` after a quote-introducing `أَنَّ :`, `تَوَافُرَ/لَازَمَهُ` (`لَازِمُهُ`).
* Chunk boundaries (256 characters): the engine and the rules cannot see across them (`إلَى | قَلَمُ`).
* Lexical items not in the lexicon: `تَخْلُصُ`, `نَعَتْ`, `اخْتَتَمَتْ` (owner's gold itself has `وَنَعَيَتْ`: not learned), `تُؤَوَّلُ`->`تَؤُولُ`, `فَصَّلَتْ` (engine: 1st person `فَصَّلْتُ`), `مُبَاشِرَةٌ`, `وِزَارَةِ`, `مُؤَكِّدًا`, `يَسْتَحِقُّ` (engine passive in one place).
* Hamza / ى-ي base-letter spelling is not touched here (suggestions only, owned by the proofreading module); the hamza mark on a plain alef (`أَنَّ`, `أَبُو`) is only placed for the lexicon entries.
* The rules are only active with a real engine (never in `MIZAJ_ENGINE_MODE=mock`); switch with `grammar_fixes=false`.
