# E2E notes

- Every spec launches its own Electron app with a private `MIZAJ_USER_DATA_DIR` (mkdtemp) and runs
  serially (`workers: 1`); nothing is shared between spec files.
- Wait for `status-sidecar` = ready before interacting. The app then runs a startup bootstrap
  (settings + project list). The stores guard against that load (and search-as-you-type loads)
  overwriting newer local state: stale responses are discarded (see `stores/projects.ts` epoch,
  `stores/settings.ts` load vs update, and the load sequence guards in the list components).
  Tests must not rely on sleeps to dodge those races; if a list looks stale, fix the store.
- Always `npx electron-vite build` before running: tests drive `out/`, not the sources.
