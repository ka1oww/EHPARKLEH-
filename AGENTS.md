# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Production topology, safe timing interpretation, and the no-secret smoke
  command are documented in `docs/production-readiness.md`.
- Validate frontend changes with the scripts in `frontend/package.json` and
  backend changes with `cd backend && venv/bin/python -m pytest -q`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
