# Verification and known-risk workflow

Read this reference before testing, changing observable behavior, fixing a bug, or reporting completion.

## Backend checks

Run from `backend/`.

```bash
./run_tests.sh tests -q
./run_tests.sh tests/test_guides.py -q
./run_tests.sh tests/test_api_contract.py -q
./run_tests.sh tests -q --cov
```

- Prefer the explicit `tests` path. Bare `./run_tests.sh` asks pytest to collect every `test_*.py` in `backend/`, including any developer scratch file such as `test_api.py`.
- Tests set `DATABASE_PATH` before importing application modules, use a fresh temporary SQLite database, clean it for every test, and remove it at session end.
- S3 and VK calls are mocked by autouse fixtures. If a new call site bypasses those patches, update the fixture before running it.
- Focused selection also works, for example `./run_tests.sh tests -k guides -q`.
- `--cov` writes `htmlcov/`; do not commit it.
- The CI workflow uses Python 3.12 and runs `python -m pytest` from `backend/`.

`backend/check_live.py` is not a unit test. It targets a running server. Without `--read-only` or supplied credentials it registers a temporary user, so default to:

```bash
python3 check_live.py --url https://host.example --read-only
```

Do not run a live or mutating check unless the user placed that environment in scope.

## Strict xfails are the bug ledger

Many backend tests use `@pytest.mark.xfail(strict=True)` to specify desired behavior for known defects. This means:

- an expected failure keeps the suite green;
- an unexpected pass fails the suite until the marker is removed;
- never delete or weaken such a test merely to make the suite green;
- before touching a domain, inspect its known failures:

```bash
rg -n -C 3 'xfail|reason=' tests/test_<domain>.py
```

The current ledger covers security and integrity risks in VK login, password length/change behavior, refresh/logout handling, public profiles and contacts, email uniqueness, block/admin synchronization, guide ownership/link clearing, CORS, and malformed JWT claims. Read the exact nearby test before editing that area; test line references in reason strings may drift.

## Frontend checks

Run from `frontend/`.

```bash
npm run lint
npm run build
npm test -- --run src/utils/api/tests/zod.test.ts
```

- `npm run build` runs TypeScript project compilation before Vite. The Rollup visualizer is enabled and may generate ignored `stats.html`; large chunks currently produce a warning rather than failure.
- The Zod file is a self-contained unit suite.
- `src/utils/api/tests/auth.test.ts` is actually a live integration test: it calls `http://127.0.0.1:8000/api`, registers users, and needs a running backend. Do not include it in an isolated unit claim or point it at shared/production data.
- The test environment mocks `js-cookie`, but not HTTP.
- CI uses Node 20, `npm ci`, lint, and build. The Docker builder currently uses Node 24.

## Cross-stack verification matrix

| Change | Minimum focused verification |
| --- | --- |
| Pydantic schema or route | affected backend test file + API contract tests |
| Auth/token/cookie logic | auth login/token tests + API contract tests |
| ORM, migration, or synchronization | affected domain tests + a fresh import against a temporary database |
| Frontend DTO/API module | TypeScript build + relevant Vitest file |
| React page/component | lint + build; verify loading, empty, error, permission, desktop, and mobile states as relevant |
| Upload behavior | backend upload tests + frontend build; keep S3 mocked |
| Deployment config | build images/config validation if available; do not deploy implicitly |

## Baseline interpretation

Do not bake a transient pass/fail count into the skill. Before each task:

1. Capture `git status` and the focused baseline before editing.
2. Distinguish failures caused by local untracked work, required external services, known strict xfails, and actual regressions.
3. Re-run the same focused check after editing.
4. Report exact commands and outcomes, including warnings or tests intentionally not run.
