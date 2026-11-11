# Export-fidelity fixtures

Real-world-shaped Arabic Word files used by `tests/test_export_fidelity.py` to check that every
Word export keeps the original formatting (fonts, colours, sizes, spacing, tables, images,
headers/footers, footnotes, text boxes, fields, bookmarks, hyperlinks) and only changes text.

- `legal_memo.docx`: built by `build_fixtures.py` (python-docx + raw XML): RTL legal memo with
  mixed run formatting, highlight, tabs, breaks, page break, numbered list, merged-cell table with
  shading, inline image, hyperlink, bookmark, header and footer with a PAGE field.
- `lo_memo.docx`: built by `build_fixtures.py` through LibreOffice (FODT -> DOCX): footnote, text
  box (frame), list, table, header/footer with page number.
- `ar_*.docx`: Microsoft-Word-authored documents from the Apache POI test corpus
  (Apache-2.0, https://github.com/apache/poi/tree/trunk/test-data/document) whose text was
  replaced by Arabic words with `arabize.py`, so the real Word structure (rsids, proofErr,
  content controls, fields, comments, footnotes, several headers/footers) is kept.
