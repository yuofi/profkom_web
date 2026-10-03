---
name: profkom-web
description: "Work safely and consistently in the profkom_web repository: React/Vite frontend, FastAPI/SQLite backend, authentication, roles, guides, blocks, contacts, PGAS, events, uploads, tests, and deployment. Use whenever inspecting, changing, reviewing, testing, or deploying this project; do not apply it to the sibling profkom_web-service copy or archive unless explicitly requested."
---

# Profkom Web

Use this file as the durable project memory. Treat the current working tree and tests as the source of truth when they disagree with this skill; update the skill when a durable architectural fact changes.

## Establish scope first

- Work in the Git repository that contains this skill (`profkom_web/`). The parent directory also contains `profkom_web-service/` and `profkom_web-service.zip`; they are stale/export copies, not the default edit target.
- Start with `git status --short --branch`. Preserve all pre-existing edits and untracked files; this repository is often used with unfinished local work.
- Never inspect or print secret values from `.env`. The tracked `.env.example` files document only part of the required configuration.
- Do not edit generated or local state: `frontend/node_modules/`, `frontend/dist/`, `backend/.venv/`, SQLite databases, coverage output, or `stats.html`.
- Read `GEMINI.md`. If `graphify-out/graph.json` exists, use the documented `graphify query/path/explain` flow before broad source searches. The graph is gitignored and may be absent.

## Load only the relevant memory

- For any code or architecture task, read [references/architecture.md](references/architecture.md).
- Before running tests, changing behavior, fixing a bug, or claiming completion, read [references/verification.md](references/verification.md).
- For backend behavior, consult `backend/TESTING.md` and the relevant tests before trusting `backend/README.md`; parts of the README describe older APIs.
- For frontend work, follow the existing design tokens and component patterns in `frontend/src/styles/vars.css`, nearby CSS modules, and shared components. Do not copy the generic design manifesto in `frontend/GEMINI.md` over the established Profkom visual language.

## High-value rules

### Backend

- Run backend commands from `backend/`. Modules use flat imports such as `from database import db`, and `.env` resolution is working-directory-sensitive.
- All application endpoints are registered on an `APIRouter(prefix="/api")` in `backend/main.py`. The OpenAPI document itself remains at `/openapi.json`.
- Keep the three representations aligned when adding a persisted field: SQLAlchemy ORM and migration helpers in `database.py`, dataclasses in `models.py`, and Pydantic request/response schemas plus mappings in `main.py`. Then update frontend API types if the field crosses the boundary.
- SQLite schema upgrades currently run during `database.py` import via `_ensure_sqlite_*` helpers. Preserve existing data and make additions idempotent; there is no Alembic.
- Never update block membership or derived admin rights with ad-hoc writes. Use and, when necessary, repair the synchronization helpers in `Database`.
- Backend authorization is authoritative. UI route guards and hidden buttons are convenience only.
- Keep S3 tests mocked. Live VK, S3, production databases, and mutating health checks require explicit task scope and appropriate authorization.

### Frontend

- Use TypeScript, named exports, CSS Modules, the variables in `src/styles/vars.css`, shared UI components, TanStack Query, and the API modules under `src/utils/api/`.
- Keep route builders in `src/utils/routes.ts`, API DTOs in `src/utils/api/types.ts`, and server calls in focused `*.api.ts` modules.
- The Axios client already handles the `/api` prefix, credentials, access-token injection, single-flight refresh, and one retry. Do not duplicate that behavior in pages.
- Use stable query keys and invalidate every affected key after mutations. Existing important keys include `currentUser`, `contacts`, `blocks`, `guides`, `guide`, and `pgas`.
- Production API calls are same-origin `/api`; development uses `VITE_BACKEND_URL + /api`. All variables parsed by `src/utils/env.ts` must exist at runtime.
- Local Vite development defaults to a frontend-only demo profile when `VITE_DEMO_MODE` is not `false`; keep this guard development-only so production continues to require real authentication.
- Preserve responsive behavior around the established 768px breakpoint and reuse the dark Material-like palette and local GoogleSans font.

## Change workflow

1. Identify the current contract in code and tests, including strict `xfail` cases in the affected domain.
2. Trace a cross-stack change end to end: persistence -> dataclass -> Pydantic schema/route -> TypeScript type/API -> query cache -> UI.
3. Add or adjust the smallest relevant tests. A fixed strict-`xfail` bug must have its marker removed or rewritten so an XPASS does not fail the suite.
4. Run the focused checks first, then the proportional backend/frontend checks from the verification reference.
5. Report pre-existing failures separately from regressions introduced by the change.

## Keep this memory healthy

- Record only durable, verified project facts here or in its references.
- Prefer links to authoritative code/tests over copying large catalogs that will drift.
- When architecture, commands, roles, or invariants change, update this skill in the same task.
- Do not record transient branch names, secrets, personal paths, one-off debugging state, or an exhaustive endpoint dump.
