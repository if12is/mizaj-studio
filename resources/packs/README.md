# Domain packs

Three ready-made `.mizajpack` v2 files for Mizaj Studio. Import them from the packs screen
(or `POST /api/packs2/import`); nothing is applied without the usual preview.

| File | Kind | Contents |
| :--- | :--- | :--- |
| `mizaj-legal-terms.mizajpack` | glossary | The bundled legal glossary plus about 165 contract and court terms |
| `mizaj-names-eg-gulf-levant.mizajpack` | dictionary | About 160 Egyptian, Gulf and Levantine given names and place names, fully voweled |
| `mizaj-official-phrases.mizajpack` | glossary | Salutations, honorifics and stock phrases of official letters |

## License

The data was authored for Mizaj Studio and is released under **CC0 1.0** (public domain
dedication, <https://creativecommons.org/publicdomain/zero/1.0/>). Glossary forms carry internal
vowels and shadda only; case endings are left to the engine. The content has not been reviewed by a
legal or linguistic specialist: review before professional use.

## Rebuild

Sources are the TSV files in `scripts/domain_data/` (edit them, do not edit the packs):

```
python scripts/build_domain_packs.py            # rewrites these packs and app/resources/catalog.json
python scripts/build_domain_packs.py --check    # CI: fail when the packs are stale
```

The output is byte-for-byte reproducible, so the `sha256` values in
`backend/app/resources/catalog.json` change only when the data changes. The release workflow runs
the script with `--version <release>` so the catalog download URLs
(`https://github.com/if12is/mizaj-studio/releases/download/v<version>/<file>`) match the release,
then uploads the three files as release assets.
