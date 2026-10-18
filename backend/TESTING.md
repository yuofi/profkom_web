# Backend verification

Run from `backend/` with Python 3.12 and dependencies from `requirements.txt`:

```sh
python -m pytest tests -q
python -m pytest tests/test_v13_*.py -q
python -m pytest tests/test_api_contract.py -q
```

Always specify `tests`: the root-level `test_api.py` is a developer scratch script. `run_tests.sh tests -q` remains a convenience wrapper for a local environment; CI creates an isolated environment. TestClient imports the real app, but conftest sets DATABASE_PATH before any app import, asserts the synthetic URL, cleans every domain table between cases and deletes its temporary DB afterwards. S3/VK are mocked. Migration subprocesses use separate temporary legacy databases. Never point this suite at shared or production data.

The route inventory in test_api_contract is a literal snapshot. Adding a route requires updating that snapshot and its public/protected classification. The matrix checks every route against anonymous, banned and malformed-token requests, including error envelopes and OpenAPI security. Error helpers validate the actual wire format before comparing diagnostics; they do not replace TestClient responses.

Legacy tests have been updated for API 1.3: approved content, explicit roles, owner-only current contacts, versioned legacy guide writes, disabled direct block mutation, private uploads and archive instead of physical profile deletion. Former skip-on-fixed-security probes now assert access refusal. Workflow helpers send current revisions explicitly; dedicated stale/concurrency tests check revision conflicts and rollback.

The v13 files cover registration limits/history, exact 72-hour substitution, membership/participation boundaries, tracker privacy and dates, immutable summaries and atomic corrections, historical reports/files, workspace/notifications/XLSX, materials/draft-file ACL, directory/avatars, archive/cleanup/retry queues, old-schema migration and competing commands. Migrations are rehearsed on synthetic old tables and applied twice; original guide text, IDs, PGAS and user counts are checked.

Frontend checks from `frontend/`:

```sh
npm run lint
npm run build
npm test -- --run
PROFKOM_TEST_API_ORIGIN=http://127.0.0.1:18000 npm run test:integration
```

The default suite excludes integration tests. The integration configuration only accepts localhost and calls the actual HTTP API through frontend clients. Use a disposable backend with synthetic chair@example.com / Synthetic-Local-2026; never provision these credentials on a shared installation. Integration exercises pending registration, approval of the same user, safe directory DTOs and material save/publication. Browser verification uses VITE_DEMO_MODE=false against the same local API.

`check_live.py` targets a running server and may create users unless `--read-only` is supplied. It is separate from isolated tests. Real provider VK verification, private S3 PUT/HEAD/GET/CORS, production migrations, image builds and deployed smoke tests must be reported separately from mocked/local checks.
