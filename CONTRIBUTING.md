# Contributing to Mizaj Studio (مِزَاج)

Thank you for helping make Arabic text tools better. Contributions are welcome in English or Arabic:
code, tests, Arabic linguistic data (currencies, glossary terms, templates, spelling patterns),
documentation and bug reports from real documents.

This document defines the conventions for both human developers and AI coding agents
(Google Jules, Cursor, Claude Code, OpenCode). [`AGENTS.md`](./AGENTS.md) is the single source of truth
for architecture and security rules; read it before touching the engine, the sidecar or the Electron main process.

## 0. Getting started

### Pick something to work on
- Issues labelled [`good first issue`](https://github.com/if12is/mizaj-studio/labels/good%20first%20issue)
  are small, self-contained and come with pointers to the files involved.
- Issues labelled [`help wanted`](https://github.com/if12is/mizaj-studio/labels/help%20wanted) are larger.
- Comment on the issue before you start so two people do not do the same work.
- For a new feature, open an issue first and describe what it does for the user.

### Set up a development environment
You do not need the 180 MB model weights: the engine has a deterministic **mock mode**
(`MIZAJ_ENGINE_MODE=mock`, see `AGENTS.md` §3) that every test runs against.

```bash
git clone https://github.com/if12is/mizaj-studio.git
cd mizaj-studio
./scripts/setup_env.sh          # Windows: .\scripts\setup_env.ps1

# Backend tests (Python 3.11)
cd backend
MIZAJ_ENGINE_MODE=mock .venv/bin/pytest

# Desktop app (Node 20)
cd ../desktop
npm run dev                     # run the app
npm run typecheck && npm run lint && npm run test:unit
```

### Where things live
| Area | Path |
| --- | --- |
| Tashkeel engines (mishkal / CATT) | `backend/app/engine/` |
| DOCX preservation | `backend/app/docx/` |
| Spelling and proofreading | `backend/app/spelling/` |
| Legal tools (tafqeet, redaction, templates, glossary) | `backend/app/legal/` and `backend/app/legal/data/` |
| Prosody (عروض) | `backend/app/arud/` |
| Quran detection | `backend/app/quran/` |
| Desktop UI (Vue 3 + CodeMirror 6) | `desktop/src/renderer/` |
| Electron main process | `desktop/src/main/` |
| Word add-in | `desktop/word-addin/` |

## 1. Licensing Policy (GPL-3.0)
Mizaj Studio is licensed under **GPL-3.0-or-later**. This ensures full legal compatibility with Arabic NLP libraries licensed under GPL-3.0 (`mishkal`, `pyarabic`, `qalsadi`) alongside MIT/Apache-2.0 libraries (`libtashkeel`, `onnxruntime`, `python-docx`, `catt`). Every source file must respect open-source attribution.
By submitting a pull request you agree that your contribution is licensed under the same terms.
Do not add data (dictionaries, corpora, fonts, models) unless its license allows redistribution under GPL-3.0; name the source and license in the PR.

## 2. Version Pinning & Environment
- **Node.js:** `20.11.0` (enforced via `.nvmrc` and `package.json` `engines`).
- **Python:** `3.11.7` (enforced via `.python-version`).
- **Dependencies:** All dependencies in `backend/requirements.txt` and `desktop/package.json` MUST use exact version pins (`==` in Python, exact semver in Node) to guarantee reproducible builds across CI and agent VMs.

## 3. Code Formatting & Linting
- **Python (`backend/`):** Linted and formatted using `ruff` (`ruff check .` and `ruff format --check .`).
- **TypeScript/Vue (`desktop/`):** Linted with `ESLint` and formatted with `Prettier` (`npm run lint` and `npm run typecheck`).

## 4. Branching & Pull Request Checklist
1. Execute one Vertical Slice or Phase per PR (or one issue per PR).
2. Ensure `MIZAJ_ENGINE_MODE=mock` unit tests (`pytest`) and E2E tests (`Playwright`) pass.
3. Update task checkboxes `- [x]` in the corresponding `docs/plan/0X_PhaseX_....md` file when your PR completes a planned task.
4. Never change base letters in tashkeel output: `strip_marks(out) == strip_marks(in)` (see `AGENTS.md` §5).

## 5. Conduct
Be respectful and patient; see [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
