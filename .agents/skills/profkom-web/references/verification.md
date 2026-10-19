# Verification workflow

Run backend commands from backend/ with an isolated Python environment. Read backend/TESTING.md for the current suite and safety boundaries.

```sh
python -m pytest tests -q
python -m pytest tests/test_v13_*.py -q
python -m pytest tests/test_api_contract.py -q
```

Always pass tests explicitly: backend/test_api.py is a scratch script. Conftest sets DATABASE_PATH before imports, asserts the synthetic DB URL, clears every domain table and deletes the temporary DB. Migration subprocesses use independent temporary legacy databases. S3/VK calls are mocked. Never run isolated tests against a real/shared database.

The API inventory is a literal snapshot, paired with anonymous/banned/malformed-token and OpenAPI checks for every route. Keep error-envelope checks on real responses. Workflow helpers may obtain a fresh revision, but dedicated missing/stale/concurrent-command tests must verify refusal and rollback.

Legacy tests describe API 1.3 behavior: approved content, explicit roles, owner-only current contacts, archive instead of physical deletion, versioned guide save and contextual private uploads. Do not restore older insecure expectations to make tests pass. Former skip-on-fixed-security probes now assert denial. If any new strict xfail appears, inspect its exact rule and remove/rewrite the marker when fixed rather than weakening the test.

Before ORM/synchronization changes, test a fresh import and old-schema migration twice. Preserve IDs, source text/PGAS references, role safety and accounting snapshots. Check the migration observation boundary separately from unknown historical tenure. For bulk changes, verify complete rollback on a bad later element. For files, test actual bytes plus permission loss and unpublished attachments.

Frontend checks from frontend/:

```sh
npm run lint
npm run build
npm test -- --run
PROFKOM_TEST_API_ORIGIN=http://127.0.0.1:18000 npm run test:integration
```

tests/live_api.py starts only a new temporary localhost database; its test-only live_storage boundary provides signed local PUT/GET and stored bytes for the real file verifier. It is never installed by the production app. Include test_integration_http_transactions.py when changing request transaction handling.

Default Vitest excludes live integration. The separate integration configuration permits localhost only and requires a disposable synthetic API. Unit mocks/build alone do not prove integration. Browser verification should use VITE_DEMO_MODE=false, current API DTOs and desktop/mobile layouts when affected. Keep all external services mocked or out of the tested flow.

check_live.py targets a running server and can register users; do not run it on shared/prod implicitly. Deployment checks are distinct: actual image build, provider VK, private S3 PUT/HEAD/GET/CORS and production smoke tests. Docker CLI availability without a running daemon is not an image-build pass.

Run focused checks first, then the full proportional regression. Report commands, evidence, warnings and environment limits accurately; do not bake transient pass counts or branch names into these instructions. Update this reference when durable architecture or verification changes.
