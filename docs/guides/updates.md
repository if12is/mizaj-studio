# Updates and delta downloads

## Application (electron-updater)

The NSIS target is built with `differentialPackage: true` (`desktop/electron-builder.yml`), so every
release ships `Mizaj-Studio-Setup-<v>.exe` **and** `Mizaj-Studio-Setup-<v>.exe.blockmap`.
`electron-updater` downloads the new blockmap, compares it with the blockmap of the installed
version and fetches only the changed blocks with HTTP range requests against the release asset.
When the old blockmap is unavailable or the changed share is too large it silently falls back to the
full installer download.

Evidence: the Windows update E2E (`.github/workflows/update-e2e.yml`, 99.0.0 to 99.0.1 and published
release to latest) completed with range requests served via the blockmap. Operational checks:

1. Keep every `*.blockmap` next to its installer in the release (the release job uploads both and
   "Verify release assets" requires the installer and `latest.yml`).
2. Never rename or re-upload an installer without its matching blockmap.
3. The release workflow appends an "Update sizes" section (installer MB, blockmap KB) to the release
   notes so size regressions are visible.

## Engine and models

The frozen engine is part of the installer, so engine code changes travel as application deltas
(the changed blocks of `mizaj-engine.exe` and the bundled libraries). Models and data are separate:

- **`.mizajpack` is the delta mechanism for models and data.** A pack contains only the new or
  changed files (a model, a dictionary, a glossary) with per-file sha256, and can be imported
  without reinstalling the application. Domain packs and the INT8 encoder are published as release
  assets and listed in `backend/app/resources/catalog.json` with pinned sha256 values.
- Model updates therefore never require a new installer, and the installer does not grow when a
  pack is added.
