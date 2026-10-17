# Contributing to Mizaj Studio (مِزَاج)

This document defines the strict engineering conventions for both human developers and AI Coding Agents (Google Jules, Cursor, Claude Code, OpenCode).

## 1. Licensing Policy (GPL-3.0)
Mizaj Studio is licensed under **GPL-3.0-or-later**. This ensures full legal compatibility with Arabic NLP libraries licensed under GPL-3.0 (`mishkal`, `pyarabic`, `qalsadi`) alongside MIT/Apache-2.0 libraries (`libtashkeel`, `onnxruntime`, `python-docx`, `catt`). Every source file must respect open-source attribution.

## 2. Version Pinning & Environment
- **Node.js:** `20.11.0` (enforced via `.nvmrc` and `package.json` `engines`).
- **Python:** `3.11.7` (enforced via `.python-version`).
- **Dependencies:** All dependencies in `backend/requirements.txt` and `desktop/package.json` MUST use exact version pins (`==` in Python, exact semver in Node) to guarantee reproducible builds across CI and agent VMs.

## 3. Code Formatting & Linting
- **Python (`backend/`):** Linted and formatted using `ruff` (`ruff check .` and `ruff format --check .`).
- **TypeScript/Vue (`desktop/`):** Linted with `ESLint` and formatted with `Prettier` (`npm run lint` and `npm run typecheck`).

## 4. Branching & Pull Request Checklist
1. Execute one Vertical Slice or Phase per PR.
2. Ensure `MIZAJ_ENGINE_MODE=mock` unit tests (`pytest`) and E2E tests (`Playwright`) pass.
3. Update task checkboxes `- [x]` in the corresponding `docs/plan/0X_PhaseX_....md` file.
