# Backend verification

Run from `backend/` with Python 3.12 and dependencies from `requirements.txt`:

```sh
python -m pytest tests -q
python -m pytest tests/test_v13_*.py -q
python -m pytest tests/test_api_contract.py -q
```

`pytest.ini` limits collection to `tests/`, so `python -m pytest` and `./run_tests.sh` without a path run the whole suite. The old scratch script lives in `scripts/manual_db_probe.py` and is never collected. `run_tests.sh` remains a convenience wrapper for a local environment; CI creates an isolated environment. TestClient imports the real app, but conftest sets DATABASE_PATH before any app import, asserts the synthetic URL, cleans every domain table between cases and deletes its temporary DB afterwards. S3/VK are mocked. Migration subprocesses use separate temporary legacy databases. Never point this suite at shared or production data.

The route inventory in test_api_contract is a literal snapshot. Adding a route requires updating that snapshot and its public/protected/service classification; the service routes of the HereBot bot (`/api/bot/v1`) take a service token instead of a user session and are checked separately (disabled 404, 401, their own OpenAPI security). `tests/test_bot_api.py` covers that API (size, schema, dedup, truncation, retention, the statement budget) and the console and grant routes; `tests/test_bot_link.py` covers the stage 2 VK link: settings, codes, the bot's confirmation and its limits, report events, registration readiness and its notices, the working-access gate after `BOT_LINK_DEADLINE`, `/api/session`, retention, the additive `users.bot_link_state` on an old schema and that the gate and the session add no SQL. `tests/test_bot_notify.py` covers stage 3, notifications through the bot: `PUBLIC_SITE_URL`, the VK row of `emit` and its conditions, VK on by default at the first link only, `GET /work` (selection, order, due time, 24 hours, waiting and refused rows, the peer after a relink, text and links of every target kind against `targetRoute` in routes.ts, `random_id`), the results in `/report` (each shape the bot sends, retries, denied with the link, idempotency, held rows cancelled), the hourly expiry, the preferences' `channels`, retention, the additive columns on an old schema twice and the statement budget (idle `/work` one SELECT over the partial index, `emit` and a task status change unchanged with the integration, a report with 50 results). `tests/test_bot_broadcasts.py` covers stage 4, broadcasts: who sends, reads and cancels (the chair, deputies, assigned senders; not the IT master or a member; the archived), the integration off, the text and its GL-07 key, nobody to reach, the recipient list fixed at send (inactive, banned and unsendable accounts out, the author in, later links out, a relink keeping the remembered VK), batches of 100 in user_id order, the bell for every active account but the author, `GET /work` (the cap of 5, due time, 24 hours, `peer_ids`, `random_id`), the results in `/report` (each shape, a sent message after a cancellation, denied with the link, retries and the fifth attempt, empty batches), the hourly expiry, cancel, the history page and its counts, retention, the tables on an old schema twice and the statement budget (idle `/work` three SELECTs over the partial indexes with the stage 5 one, `/work` with 5 batches four, a report with 5 × 100 results eight, a send and a history page the same for any size, `/api/session` unchanged). `tests/test_bot_console.py` covers stage 5, the bot console: who reads and operates it (the IT master and maintainers; not the chair, deputies or others), the integration off, the pause (its status row, audit of changes only, `/work` handing out only commands while paused, the queue waiting), the status (the queue counts, `heartbeat.updates` as sent, not an object or over 16 KiB dropped alone), creating commands (kinds and args with their defaults and 422 locations, `CommandOut`, `requested_by` to the bot, the bot offline, one open command per kind with update and rollback sharing it, a command past its term freeing it, the VK the update requests need, the 2-minute restart limit, the GL-07 key, audit), `GET /work` (terms, order, the cap of 10, `running` handed out until its result), `/report` (the state machine, order within a report, a late result after the expiry, unknown ids and statuses, clipping, the output of `logs` cut to its last 128 KiB), expiry on read and the hourly pass (expiry, outputs after 24 hours, 500 for 30 days), the history and one command, retention, the additive schema on an old database twice and the statement budget (idle `/work` three SELECTs and one while paused over `ix_bot_commands_open` with `EXPLAIN QUERY PLAN`, open commands one more, a report with results two more and a heartbeat-only report still three, the status and a command creation constant). `tests/test_service_account.py` covers the service account (SERVICE_ACCOUNT.md): settings, the idempotent startup step and schema upgrade, sign-in with the login (success, failure, off, removed and rotated configuration, the per-client limit behind nginx and against a parallel burst), its rights and the chair's own actions, the `service_account` session flag, its own profile and its save with the reserved address (kept to it alone), the console's own refusal of its update requests, absence from every list of people (parametrized, with the filter switched off they fail), refusal as assignee, member, role holder, recipient or grantee, the display name, no deadline gate or VK, both site-only sign-in notices (one per failed streak, brought up to date), the short browser summary, what it leaves to people (the queues it creates or held, closing the tasks it opened, the first chair's bootstrap) and the hash helper; `test_access_matrix.py` runs every operation as the service account. The matrix checks every route against anonymous, banned and malformed-token requests, including error envelopes and OpenAPI security. Error helpers validate the actual wire format before comparing diagnostics; they do not replace TestClient responses.

Legacy tests have been updated for API 1.3: approved content, explicit roles, owner-only current contacts, versioned legacy guide writes, disabled direct block mutation, private uploads and archive instead of physical profile deletion. Former skip-on-fixed-security probes now assert access refusal. Workflow helpers send current revisions explicitly; dedicated stale/concurrency tests check revision conflicts and rollback.

`tests/test_access_matrix.py` builds one synthetic organisation through the API and calls every operation as each of 16 roles. Expectations are the release 1 access table; a capability must be present exactly when the server accepts the command. Writes on shared fixtures send a wrong revision, so 409 means the permission check passed. `ACCESS_MATRIX_DUMP=<file>` writes the observed matrix as JSON for comparison with another commit.

`tests/test_repo_hygiene.py` fails when the repository tracks a CSV, an SQLite database or an SQL file outside the allowed list (`scripts/repo_hygiene.py`). The same rule runs before each commit once the hook is enabled in a clone: `git config core.hooksPath .githooks`.

The v13 files cover registration limits/history, exact 72-hour substitution, membership/participation boundaries, tracker privacy and dates, immutable summaries and atomic corrections, historical reports/files, workspace/notifications/XLSX, materials/draft-file ACL, directory/avatars, archive/cleanup/retry queues, old-schema migration and competing commands. Migrations are rehearsed on synthetic old tables and applied twice; original guide text, IDs, PGAS and user counts are checked.

`test_guide_embeds_materials.py` covers the opt-in rich guide format: additive old-schema
startup twice, draft/publication separation, compile outside the writer lock, post-compile
session/revision/ACL rechecks, read-only preview and GET, private image bytes and revocation.
`test_guide_embeds_compiler.py` checks the HTML5/Markdown corpus, finite tree/URL policy,
resource limits and isolated compiler process. See `docs/GUIDE_EMBEDS.md`.

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

`tests/test_tracker_reader_policy.py`, `test_tracker_iteration.py` and
`test_tracker_control_guards.py` verify the current owner policy: readers may move
ordinary working statuses, toggle checklists and edit shared comments; closure and
reopening remain author commands. Metadata and private accounting require separate
rights. Task-specific grants do not grant queue/team/private access. Managed control
epics revalidate current roles and cannot be manually altered or shared. The actual
HR deputy has global KKR authority, without unrelated report or directory privileges.
Roster removal/rejoin preserves credit, contextual files remain protected and safe
history UserRefs anonymize on read. Old public status aliases do not rewrite private
outcomes or invent completion dates.

`tests/test_season_analytics.py` covers global summary/accounting ACL, HR deputy access,
public/private status separation, distinct joint tasks versus summed assignment hours,
Moscow week boundaries, negative/merit/bonus credits, source-block/participant filters,
unknown hours/dates, current and legacy approved snapshots, new snapshot facts without
old-version backfill, repeated GET without SQL writes, and public season-move revisions,
safe history and atomic parent-link rollback. See `docs/SEASON_ANALYTICS.md` for the
durable metric definitions and closed-season completeness rules.

`test_kkr_criteria.py` pins the five criteria of the owner's table (order, wording,
multipliers) against every criteria shape and the frontend labels, compares the score
with an independently written formula, shows that the automatic deadline premium is the
only urgency, and that a record or template stored with a key the table does not name
reads, scores and re-saves (same revision) as if the key were absent, while input with
such a key is refused.
`test_kkr_iteration.py` covers atomic multi-assignee accounting, season coefficients,
managed accounting controls and immutable approved snapshots, and the KKR summon circle
(HR master and HR deputy, open/summarizing seasons only) for every role.
`test_closed_season_editors.py` checks, role by role, who changes a closed season (the
chair, deputies and HR master, owner decision 2026-10-31) across marks, corrections,
coefficients, task fields, assessment inputs/dates, review, merit edits and new merits of
every kind (a closed event's too), with matching
capabilities, and that new assignment rows there (join, take, assign, reassignment) follow
the same circle: one new row for the HR master, refusals for the HR deputy, block master
and members (TR-05).
`test_archive_restore_release.py` also checks, role by role, that only the chair archives
or restores a chair deputy (the deputy themselves included), that the refusal precedes
restore conflict prompts and that archive items carry `restore_account` (PE-01). `test_portal_core_iteration.py`
checks the deadline-free formula and new event/chair work sources. Synthetic legacy
schema imports are repeated through each supported import order in
`test_portal_migration_iteration.py`; queue rebinding uses explicit source IDs and
rejects changes to closed historical work.

### Чаты задач (`chat_announcements_v1`)

`tests/test_task_chat.py` проверяет одноразовую привязку с долговечными лимитами,
scoped ACL/сервисный аккаунт, общую транзакцию task+outbox и GL-07,
конкурентные create/claim, fencing, неизменяемые части, повтор после потерянного ACK,
отвязку/CAS, закрытую очередь, offline, изменение исполнителей и retention.
Startup репетируется дважды на SQLite backup синтетической старой схемы:
сравнение прежних строк и `integrity_check`. Старые bot API SQL-бюджеты и JSON
проверяет существующий `test_bot_api.py`; новые маршруты входят в общий API-инвентарь.
Контракт: [TASK_CHAT_ANNOUNCEMENTS.md](docs/TASK_CHAT_ANNOUNCEMENTS.md).

`tests/test_task_chat_end_to_end.py` дополнительно проходит публичные HTTP-команды
от привязки до доставки/повтора/отвязки. Необязательная совместная проверка с
настоящим HereBot включается переменными `PROFKOM_TASK_CHAT_BOT_SOURCE`
(локальный checkout с `core/site_chat.py`) и `PROFKOM_TASK_CHAT_BOT_PYTHON`
(путь к Python его venv, без разрешения symlink). Она запускает только временный
uvicorn на случайном localhost-порту, два последовательных процесса бота с одной
временной SQLite и подменённым VK. Проверяется восстановление трёх частей для
101 участника без повторной отправки первой. Сервер и процессы завершаются тестом.

Для отдельного ограниченного замера можно передать
`PROFKOM_TASK_CHAT_PERF_REPORT=/absolute/local/path/performance.json`: 30 пар
HTTP-созданий без/с намерением рассылки и 100 одновременных созданий при offline
синтетическом боте. Проверяются 100 различных задач и 100 сохранённых outbox-записей.
В обычном pytest этот замер не выполняется; локальные числа не являются оценкой
production. HereBot PostgreSQL следует проверять отдельно на одноразовой БД:
этот межсервисный тест использует SQLite и не подключается к существующей БД бота.

`tests/test_block_lifecycle.py` covers strict block creation/rename permissions, two
distinct human approvals (service refusal), block CAS/request identity, the durable
72-hour clock with 24/48-hour notices to every current leader, cancellation and
role loss, concurrent approvals/workers, bounded catch-up, failure isolation,
read-only GET/idle polls, archival guards, historical ACL/current-role separation,
startup twice and integrity. `test_block_lifecycle_acceptance.py` combines public
HTTP, actual avatar bytes, queue/chat lock, seasonless historical-task closure and
unchanged pre-existing KKR/guide identities. See `docs/BLOCK_LIFECYCLE.md`.
