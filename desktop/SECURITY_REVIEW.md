# Desktop security review (Phase 8, Slices 8.1.1 desktop side, 8.2, 8.4.1)

Scope: `desktop/src/main/**`, `src/preload/**`, `electron-builder.yml`, `build/afterPack.cjs`,
`src/renderer/index.html`, `src/renderer/src/api/**`, `stores/sidecar.ts`.

## Threat model

| Asset | Attacker | Vector |
|---|---|---|
| Sidecar HTTP API (documents, dictionary, file read/write by path) | other local process or user; any web page in a browser | loopback port scan, DNS rebinding, CSRF |
| Renderer to OS (files, shell, processes) | XSS or malicious document content reaching the renderer; a compromised dependency | IPC abuse, navigation, popups, `<webview>`, Node access |
| Packaged binary | local attacker with env or CLI control | `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`, asar swap |
| Update channel | network attacker / flaky network | tampered or truncated installer |
| Secrets | log or bundle readers | token in logs, crash reports, argv |

Out of scope: a fully compromised OS account, backend-side validation (8.1.2 to 8.1.7, owned by the backend work).

## Findings and fixes

| # | Finding (before) | Fix (after) | Test |
|---|---|---|---|
| 1 | Sidecar API unauthenticated | Per-launch token `crypto.randomBytes(32)` hex (`security.ts`), passed to the sidecar via env `MIZAJ_API_TOKEN` only (never argv), reused across sidecar restarts. Renderer receives it only from `getBackendConfig()`. `ApiClient`, SSE stream and `/health` polling send `X-Mizaj-Token`; main-process diagnostics fetches send it too | `security.test.ts`, `pythonManager.test.ts` (env only, restart reuse, overrides inherited), `api/token.test.ts`, e2e `security.spec.ts` (401 without or with a wrong token, 200 with it, `/health` public) |
| 2 | Token leakage | `scrubSecrets` + electron-log hook (`logger.ts`) redact the registered token, `X-Mizaj-Token:` and `MIZAJ_API_TOKEN=` forms in strings, Errors and nested objects. Diagnostics bundle and crash reports additionally redact any 64-hex run. The token is not put in main's `process.env` unless `MIZAJ_E2E_EXPOSE_TOKEN=1` (test convention) | `logger.test.ts`, `security.test.ts`, `diagnostics.test.ts`; e2e checks logs and every `/proc/*/cmdline` for the token |
| 3 | Window hardening incomplete | `webPreferences`: contextIsolation, sandbox, nodeIntegration=false, webSecurity, allowRunningInsecureContent=false, spellcheck off, webviewTag off, no node in workers or subframes. Preload only `require('electron')` (sandbox-compatible; verified in the built output) | e2e `security.spec.ts` |
| 4 | Navigation was `file://*` prefix match | `hardening.ts` applies to every webContents: `will-navigate` and `will-redirect` allow only the exact app `index.html` (or the dev origin); `setWindowOpenHandler` denies, opening allowlisted https links externally; `will-attach-webview` blocked | `isAppUrl` unit tests, e2e (window.open returns null, `location.href` stays) |
| 5 | Permissions default | `setPermissionRequestHandler`, `setPermissionCheckHandler`, `setDevicePermissionHandler` deny everything; spell-checker off | e2e (notification, mic, geolocation not granted) |
| 6 | CSP allowed `ws://localhost`, no `object-src`, `base-uri` | Strict CSP in `index.html` and, for the app's own documents, as an HTTP header via `session.webRequest` (adds `frame-ancestors 'none'`, which a meta tag cannot carry). `script-src 'self'`, no `unsafe-eval`, `object-src/base-uri/form-action 'none'`, `connect-src 'self' http://127.0.0.1:*`, `img-src 'self' data: blob:` | e2e (inline script blocked and reported; policy has no `unsafe-eval`); packaged run shows 0 console errors |
| 7 | IPC handlers trusted any sender | `ipcGuard.ts`: `handleSecure` / `onSecure` check `senderFrame` is a top-level frame at the app URL; all handlers (window, dialogs, shell, updater, diagnostics, about, backend config, flush) use them | `ipcGuard.test.ts` |
| 8 | `shell:open-path` opened any string | Only paths returned by a native dialog (or the documented `MIZAJ_E2E_*` stubs) within the last 10 min (max 64), bounded length, no NUL | `PathAllowlist` tests, e2e (`/etc/passwd` rejected) |
| 9 | `openExternal` accepted any https | https only, no credentials, port 443, host allowlist: tanzil.net, github.com, microsoft.com, tesseract-ocr.github.io, ollama.com, languagetool.org, creativecommons.org, sourceforge.net (subdomains included; the last is for catalog license links). Rejections are logged (host only) | `security.test.ts`, `fileIpc.test.ts`, e2e |
| 10 | Argument validation | Dialog options must be objects; extension list capped at 20, `[A-Za-z0-9]{1,10}`; names capped at 255; filter names at 64 | `fileIpc.test.ts` |
| 11 | No fuses | `build/afterPack.cjs` (pinned `@electron/fuses@1.8.0`): RunAsNode off, CookieEncryption on, NodeOptionsEnv off, NodeCliInspect off, EmbeddedAsarIntegrity on, OnlyLoadAppFromAsar on | Verified with `electron-fuses read` on the Linux build; AppImage launches and the sidecar reaches READY |
| 12 | userData hygiene | On start: remove `<userData>/tmp/*`, top-level `*.tmp` and `.~mizaj_tmp*`, crash reports older than 30 days or beyond 50; POSIX `0700` on userData, logs and crash. `.part` and `.partial` files are deliberately kept (resumable downloads, 8.4.2) | `userData.test.ts` |
| 13 | Update errors were silent or fatal | See 8.4.1 below | `updater.test.ts`, `scripts/update-resilience.mjs` |

### Fuses: caveats found while verifying

1. **Playwright cannot attach to a packaged app when `EnableNodeCliInspectArguments` is off.** The Windows installed-app e2e and `scripts/update-e2e.mjs` launch the installed exe through Playwright, so those two workflows set `MIZAJ_E2E_BUILD=1` when packaging. That leaves only this fuse on, with a loud warning; release builds never set it. The `.github/workflows/windows-e2e.yml` and `update-e2e.yml` steps were edited accordingly. The normal e2e harness launches `out/main` with the electron binary and is unaffected.
2. **ASAR integrity on Windows.** electron-builder 24.13 embeds the asar digest only on macOS. Enabling the fuse on a Windows exe without the digest risks an app that will not start. `afterPack` enables it on Windows only if the exe carries an `ELECTRONASAR` resource, otherwise it logs a warning and leaves it off. Linux ignores the fuse. **Not verified on real Windows or macOS from this Linux sandbox**; a Windows CI smoke of the installed app is the check. Upgrading to electron-builder 25+ (native fuse and integrity support) would close the gap.
3. `OnlyLoadAppFromAsar` works with this layout (the engine and models are in `extraResources`, outside the asar).
4. The packaged `backend/dist/mizaj-engine` in this checkout predates the token middleware, so the packaged run did not return 401 for a missing token. The development sidecar (used by e2e) does.

### CSP residual

`style-src` keeps `'unsafe-inline'`: CodeMirror (style-mod) injects `<style>` elements at runtime and a per-load nonce is not possible for a static `file://` page. Scripts remain `'self'` only, so this does not allow script injection. In dev, Vite HMR's `ws://localhost` is blocked by the meta CSP; a dev-only `transformIndexHtml` plugin in `electron.vite.config.ts` could relax it (not changed here).

## 8.4.1 Resilient updates

`UpdaterController` additions:

- Network errors (ECONNRESET, ETIMEDOUT, `net::ERR_*`, HTTP 408/429/5xx, truncated or checksum-failed downloads) schedule retries after **30 s, 2 min, 10 min, 10 min, 10 min** (max 5), then surface `error`. 404/403/parse errors are not retried. Only the first line of the message is classified (response headers such as `Keep-Alive: timeout=5` follow it).
- Status `retrying` with `phase` ('check' or 'download'), `attempt`, `maxAttempts`, `nextRetryAt` (epoch ms, or `null` while waiting for connectivity), `offline`. One status per scheduled retry. Background check failures stay silent (idle).
- Offline (`net.isOnline()` false): no attempts are spent; a 10 s poll resumes as soon as the network is back, and `powerMonitor` `resume` triggers an immediate attempt. A manual "check" short-circuits the backoff.
- The 6-hourly tick is unchanged and skipped while a retry is pending.

**Interrupted-download experiment** (`npm run test:updater-net`, real electron-updater AppImage provider + generic feed, Electron under xvfb, local server). Sequence served: connection dropped at 40 % (`ERR_CONTENT_LENGTH_MISMATCH`), full length with one flipped byte, a short file, then the intact file. Result: `retrying#1..#3`, then `downloaded`. The cache `pending/` ended with only the intact AppImage and `update-info.json`: electron-updater downloads to `temp-*`, verifies sha512, then renames, and deletes the file on any failure. Corrupt or incomplete files are never installable. Behaviour on retry is a clean restart (full downloads send no Range; the differential path reuses blocks of the installed AppImage/NSIS file), not byte-level resume.

**UI follow-up needed (not my files):** `UpdateBanner.vue` shows only `available`, `downloading`, `downloaded`; during a download retry the banner disappears until the download restarts. It should render `retrying` (e.g. "Connection lost, retrying at `nextRetryAt`" / "Waiting for network"). `stores/updater.ts` already forwards any state.

## Test inventory

- Unit (vitest, 235 tests): `security`, `ipcGuard`, `userData`, `logger` (scrub), `pythonManager` (token), `updater` (fake updater + fake timers: backoff schedule, budget, offline, wake, manual override, classification), `api/token`.
- E2E: `tests/e2e/security.spec.ts` (new, 5 tests); existing specs updated to send the token. Exports now go outside `userData` because the backend refuses writes into its data directory.
- Script: `scripts/update-resilience.mjs`.

## Residual risks

- A compromised renderer can still call every exposed IPC method and read the token (required for it to talk to the API). Mitigations: sender checks, allowlists, CSP.
- Paths from drag and drop (`webUtils.getPathForFile`) go straight to the backend, which must validate them (8.1.3).
- `MIZAJ_E2E_*` stubs are honoured in packaged builds (needed by the installed-app e2e); they require control of the process environment.
- No downgrade protection beyond electron-updater's `allowDowngrade=false`; sha512 comes from the release feed, so feed integrity relies on GitHub HTTPS (code signing is the next layer).
