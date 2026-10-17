# Releasing Mizaj Studio

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on `windows-latest`
and published as a normal (non-draft) GitHub Release on `if12is/mizaj-studio`.

## Cut a release

**Option 1 - tag (recommended)**

```bash
git tag v0.1.0
git push origin v0.1.0
```

The tag name is the version: `v0.1.0` -> `0.1.0` is written into `desktop/package.json` by
`desktop/scripts/sync-version.cjs` (the build fails if the tag is not valid semver).

**Option 2 - manual run**: GitHub > Actions > _Release_ > _Run workflow_.
Inputs: `version` (optional, e.g. `0.1.1`; empty keeps the `package.json` version),
`publish` (default true; false = build and upload workflow artifacts only),
`runner` (`github-hosted` or `self-hosted` = `[self-hosted, Windows]`).
When publishing from a manual run, electron-builder creates the tag `v<version>` itself.

No secrets are needed: the workflow uses the built-in `GITHUB_TOKEN` (`contents: write`).

## What the workflow does

1. Syncs the version, generates release notes from `git log` since the previous tag.
2. Quality gate: backend `pytest` (mock engine), `npm ci`, lint, typecheck, unit tests.
3. `python scripts/download_models.py` (real download, SHA256 verified).
4. `python scripts/build_backend.py` -> `backend/dist/mizaj-engine` (PyInstaller onedir).
5. Smoke test of the frozen engine on Windows (`desktop/scripts/smoke-engine.ps1`:
   starts it with `--port 0`, reads `MIZAJ_PORT`, `GET /health`, `POST /api/tashkeel` in
   accurate mode, then kills it).
6. `npm run build` and `electron-builder --win --publish always|never`.
7. Uploads `*.exe`, `latest.yml`, `*.blockmap` as an artifact, sets the release notes, and
   verifies with `gh release view` that `Mizaj-Studio-Setup-<version>.exe` and `latest.yml`
   exist and that the release is not a draft.

## What gets published

`Mizaj-Studio-Setup-<version>.exe` (NSIS, Arabic + English installer), its `.blockmap`
(differential updates) and `latest.yml` (read by the in-app updater). The engine
(`resources/engine`) and the CATT models (`resources/models/catt_eo`) are inside the installer.

## Unsigned builds / SmartScreen

The installer is **not code-signed** (no certificate is configured). Windows SmartScreen will
show "Windows protected your PC": click _More info_ > _Run anyway_. Signing can be added later
by providing a certificate secret (`CSC_LINK` / `CSC_KEY_PASSWORD`) to electron-builder.

## How auto-update works

- Only the packaged app checks for updates (never in development). The provider is `github`
  (`if12is/mizaj-studio`), configured into `app-update.yml` by electron-builder.
- Automatic check: 10 s after start and every 6 h, unless the user turns off
  _Settings > التحديثات > التحقق التلقائي من التحديثات_ (`auto_update_check`). This is the app's
  only automatic network access (exception to the zero-egress rule). The manual button
  _التحقق من التحديثات_ works regardless of the toggle.
- Nothing is downloaded without consent: a banner says "يتوفر إصدار جديد X"; **تنزيل** downloads
  (progress bar), then **إعادة التشغيل والتثبيت** flushes autosave, stops the Python sidecar and
  calls `quitAndInstall(false, true)`.
- Air-gapped machines can update only the models from a `.mizajpack` file
  (Settings > النماذج).

## Testing an update 0.1.0 -> 0.1.1

1. Release `v0.1.0`, install it on a Windows machine (note the SmartScreen prompt).
2. Release `v0.1.1` (tag or manual run). Check the release has the `.exe` and `latest.yml`.
3. Start the installed 0.1.0 app: after ~10 s the banner "يتوفر إصدار جديد 0.1.1" appears
   (or press _التحقق من التحديثات_ in Settings).
4. Click _تنزيل_, wait for 100 %, click _إعادة التشغيل والتثبيت_: the app restarts as 0.1.1
   and the documents are intact (autosave was flushed first).
5. Negative checks: with the toggle off nothing is checked automatically; offline, background
   checks fail silently while the manual button shows an error message.

Local packaging check without GitHub: `npm run dist:linux` (AppImage) or `npm run dist:win`
on Windows (`--publish never`).
