# Backend verification

Run from `backend/` with Python 3.12 and dependencies from `requirements.txt`:

```sh
python -m pytest tests -q
python -m pytest tests/test_v13_*.py -q
python -m pytest tests/test_api_contract.py -q
```

`pytest.ini` limits collection to `tests/`, so `python -m pytest` and `./run_tests.sh` without a path run the whole suite. The old scratch script lives in `scripts/manual_db_probe.py` and is never collected. `run_tests.sh` remains a convenience wrapper for a local environment; CI creates an isolated environment. TestClient imports the real app, but conftest sets DATABASE_PATH before any app import, asserts the synthetic URL, cleans every domain table between cases and deletes its temporary DB afterwards. S3/VK are mocked. Migration subprocesses use separate temporary legacy databases. Never point this suite at shared or production data.

The route inventory in test_api_contract is a literal snapshot. Adding a route requires updating that snapshot and its public/protected classification. The matrix checks every route against anonymous, banned and malformed-token requests, including error envelopes and OpenAPI security. Error helpers validate the actual wire format before comparing diagnostics; they do not replace TestClient responses.

Legacy tests have been updated for API 1.3: approved content, explicit roles, owner-only current contacts, versioned legacy guide writes, disabled direct block mutation, private uploads and archive instead of physical profile deletion. Former skip-on-fixed-security probes now assert access refusal. Workflow helpers send current revisions explicitly; dedicated stale/concurrency tests check revision conflicts and rollback.

`tests/test_access_matrix.py` builds one synthetic organisation through the API and calls every operation as each of 16 roles. Expectations are the release 1 access table; a capability must be present exactly when the server accepts the command. Writes on shared fixtures send a wrong revision, so 409 means the permission check passed. `ACCESS_MATRIX_DUMP=<file>` writes the observed matrix as JSON for comparison with another commit.

`tests/test_repo_hygiene.py` fails when the repository tracks a CSV, an SQLite database or an SQL file outside the allowed list (`scripts/repo_hygiene.py`). The same rule runs before each commit once the hook is enabled in a clone: `git config core.hooksPath .githooks`.

The v13 files cover registration limits/history, exact 72-hour substitution, membership/participation boundaries, tracker privacy and dates, immutable summaries and atomic corrections, historical reports/files, workspace/notifications/XLSX, materials/draft-file ACL, directory/avatars, archive/cleanup/retry queues, old-schema migration and competing commands. Migrations are rehearsed on synthetic old tables and applied twice; original guide text, IDs, PGAS and user counts are checked.

Frontend checks from `frontend/`:

```sh
npm run lint
npm run build
npm test -- --run
```

The integration suite destroys data (it closes seasons), so it has no default target. Start a disposable API on a free port from `backend/`; it creates a new temporary database and prints a nonce:

```sh
python tests/live_api.py --integration-suite --port 18080
```

With `--integration-suite` cursor lists answer in pages of 3 (`api_contract.PAGE_SIZE`), so the suite walks them page by page.

Then run from `frontend/` with both values; without them, or if the API does not return the same nonce, the suite stops before the first test:

```sh
PROFKOM_TEST_API_ORIGIN=http://127.0.0.1:18080 PROFKOM_TEST_API_NONCE=<printed nonce> npm run test:integration
```

Browser checks (Playwright, `e2e/`) open the production build through `vite preview`. Build it with `VITE_BACKEND_URL` of a disposable `tests/live_api.py`, `VITE_DEMO_MODE=false`, then run from `frontend/` with an installed Chromium-based browser (no browser is downloaded):

```sh
PROFKOM_BROWSER=<path to the browser executable> PROFKOM_E2E_PORT=49180 npm run test:e2e
```

Every page may reach only localhost: other requests are aborted and listed by `e2e/fixtures.ts`, and a check fails on an unknown external origin. Projects cover desktop 1280×900 and mobile 390×844.

The default suite excludes integration tests. The integration configuration only accepts localhost and calls the actual HTTP API through frontend clients. Use a disposable backend with synthetic chair@example.com / Synthetic-Local-2026; never provision these credentials on a shared installation. Integration exercises pending registration, approval of the same user, safe directory DTOs and material save/publication. Browser verification uses VITE_DEMO_MODE=false against the same local API.

`check_live.py` targets a running server and follows the API 1.3 contract. Without `--read-only` it registers a pending user (or, with `--email`, also sends denied writes and edits then restores the account's own `location`). `--read-only` sends only GET and CORS preflight, plus `POST /api/auth/login`, `/refresh` and `/logout` with `--email`. `tests/test_check_live.py` runs every mode against a disposable `tests/live_api.py` and checks the request log. It is separate from isolated tests. Real provider VK verification, private S3 PUT/HEAD/GET/CORS, production migrations, image builds and deployed smoke tests must be reported separately from mocked/local checks.

`tests/test_tracker_queues.py` covers queue key uniqueness/immutability and per-queue
numbering, default compatibility, migration twice, current scope plus private grant
ACL, minimal locked catalogue, owner-only durable request approval/revocation and
stale/replayed decisions, cache revisions, collaborative description/comment edits
with actual actors, cross-queue parents/cycles/revoked-parent masking, rename
preservation, private credit/XLSX/version redaction with unchanged ledger snapshots,
and atomic season-correction hierarchy guards. All data/providers are synthetic.
