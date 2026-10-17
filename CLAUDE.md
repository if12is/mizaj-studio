# CLAUDE.md

See [`AGENTS.md`](./AGENTS.md) for all architectural rules, licensing (GPL-3.0), mock mode specifications, directory structure, and verification guidelines.

## Claude-Specific Workflow Notes
- Always run `pytest` inside `backend/` with `MIZAJ_ENGINE_MODE=mock` and `npm run typecheck` inside `desktop/` before concluding any task.
- Do not duplicate or override instructions defined in `AGENTS.md`.
