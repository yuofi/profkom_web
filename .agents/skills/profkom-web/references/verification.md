# Verification workflow

Run backend commands from backend/ with an isolated Python environment. Read backend/TESTING.md for the current suite and safety boundaries.

```sh
python -m pytest tests -q
python -m pytest tests/test_v13_*.py -q
python -m pytest tests/test_api_contract.py -q
```

backend/pytest.ini limits collection to tests/ (the old scratch script is scripts/manual_db_probe.py). Conftest sets DATABASE_PATH before imports, asserts the synthetic DB URL, clears every domain table and deletes the temporary DB. Migration subprocesses use independent temporary legacy databases. S3/VK calls are mocked. Never run isolated tests against a real/shared database.

The API inventory is a literal snapshot, paired with anonymous/banned/malformed-token and OpenAPI checks for every route. Keep error-envelope checks on real responses. Workflow helpers may obtain a fresh revision, but dedicated missing/stale/concurrent-command tests must verify refusal and rollback.

Legacy tests describe API 1.3 behavior: approved content, explicit roles, owner-only current contacts, archive instead of physical deletion, versioned guide save and contextual private uploads. Do not restore older insecure expectations to make tests pass. Former skip-on-fixed-security probes now assert denial. If any new strict xfail appears, inspect its exact rule and remove/rewrite the marker when fixed rather than weakening the test.

Before ORM/synchronization changes, test a fresh import and old-schema migration twice. Preserve IDs, source text/PGAS references, role safety and accounting snapshots. Check the migration observation boundary separately from unknown historical tenure. For bulk changes, verify complete rollback on a bad later element. For files, test actual bytes plus permission loss and unpublished attachments. test_local_file_integrity checks create-only sealed snapshots, old completed IDs, races and retries. test_file_seal_cutover verifies read-only dry-run and repeatable/resumable batch sealing on synthetic storage. The S3 test doubles must implement conditional server PutObject as well as signed staging PUT/GET. test_local_scope_access and frontend scope-access.test cover membership/organizer revocation, including open query observers, polling/focus and independent roles.

Frontend checks from frontend/:

```sh
npm run lint
npm run build
npm test -- --run
```

The integration suite destroys data (it closes seasons), so it has no default target. Start a disposable API on a free port from `backend/`; it creates a new temporary database and prints a nonce:

```sh
python tests/live_api.py --integration-suite --port 18080
```

Then run from `frontend/` with both values; without them, or if the API does not return the same nonce, the suite stops before the first test:

```sh
PROFKOM_TEST_API_ORIGIN=http://127.0.0.1:18080 PROFKOM_TEST_API_NONCE=<printed nonce> npm run test:integration
```

Browser checks (Playwright, `e2e/`) open the production build through `vite preview`. Build it with `VITE_BACKEND_URL` of a disposable `tests/live_api.py`, `VITE_DEMO_MODE=false`, then run from `frontend/` with an installed Chromium-based browser (no browser is downloaded):

```sh
PROFKOM_BROWSER=<path to the browser executable> PROFKOM_E2E_PORT=49180 npm run test:e2e
```

Every page may reach only localhost: other requests are aborted and listed by `e2e/fixtures.ts`, and a check fails on an unknown external origin. Projects cover desktop 1280×900 and mobile 390×844.

tests/live_api.py starts only a new temporary localhost database; its test-only live_storage boundary provides signed local PUT/GET and stored bytes for the real file verifier. It is never installed by the production app. The local storage honors signed Content-Disposition for browser downloads; a separately vacant block keeps nullable master-bonus recipients covered. legacy-guide.integration.test.tsx verifies the old URL redirect through real HTTP, private draft, separate publication and reopen. Include test_integration_http_transactions.py when changing request transaction handling.

Default Vitest excludes live integration. The separate integration configuration permits localhost only and requires a disposable synthetic API. Unit mocks/build alone do not prove integration. Browser verification should use VITE_DEMO_MODE=false, current API DTOs and desktop/mobile layouts when affected. Keep all external services mocked or out of the tested flow.

check_live.py targets a running server and can register users; do not run it on shared/prod implicitly. `--read-only` sends only GET/OPTIONS and, with `--email`, login/refresh/logout; tests/test_check_live.py guards this through the live_api request log. Deployment checks are distinct: actual image build, provider VK, private S3 PUT/HEAD/GET/CORS and production smoke tests. Docker CLI availability without a running daemon is not an image-build pass.

Run focused checks first, then the full proportional regression. Report commands, evidence, warnings and environment limits accurately; do not bake transient pass counts or branch names into these instructions. Update this reference when durable architecture or verification changes.
