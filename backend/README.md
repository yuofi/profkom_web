# Profkom Web backend — API 1.3

> Current unified-release contracts (28 October 2026): [API additions](docs/API_V13_ADDITIONS.md), [profiles/templates](docs/PROFILE_FEATURES.md), [history](docs/HISTORY.md), [retired guide API](docs/LEGACY_GUIDE_RETIREMENT.md). Earlier notes below retain historical context; the linked contracts take precedence for the changed interfaces. [User guide](../docs/USER_GUIDE_20261028.md).


FastAPI/Pydantic 2, SQLAlchemy 2 and SQLite. Run commands from `backend/`: modules use flat imports. All application routes are under `/api`; current schemas and security requirements are served at `/openapi.json` and `/docs`.

Use Python 3.12, install `requirements.txt` in a virtual environment, configure environment variables from `.env.example`, then run `uvicorn main:app --host 127.0.0.1 --port 8000`. Set an explicit `DATABASE_PATH`; use a disposable path for development/tests. Production requires `APP_ENV=production` and a unique `JWT_SECRET_KEY` of at least 32 characters. Set `FRONTEND_URL` to the actual frontend origin. The Docker image sets production mode; Compose injects `backend/.env` at runtime. Secret files are excluded from the image.

Working content requires an active approved account. Pending/rejected accounts can read/edit/resubmit their own registration. Authentication uses hashed passwords, access-token session versions and rotating single-use refresh tokens; archive, password change and logout-all revoke existing access as well as refresh tokens. VK identities are verified with the provider and linked by an explicit external subject, never by name/email or unsigned claims. A VK login whose VK ID an unlinked current account names in its saved link answers 409 `vk_link_required` instead of creating a second account. VK photos are not fetched.

Roles are explicit assignments: chair/deputies, block master/deputies, event and subevent leaders/deputies, organizers and per-material editors. Legacy admin/super_user/events_roles values are retained as data and do not grant domain rights. PGAS permission remains separate. Backend object checks are authoritative; capabilities project the same permissions for the frontend.

The domain includes versioned seasons and parallel open/planned work; scoped tasks/submissions/help/reviews and historical input corrections; source-specific KKR and frozen summary versions; immutable master-bonus bases; report drafts/publication/versions and saved closed-season editors; meetings, notifications, dashboard/calendar; two-stage block requests; participation intervals/categories; material publication and legacy guide mapping; contacts, local avatars and account retention.

Every HTTP command runs in a single database transaction. SQLite write serialization, revisions and unique indexes prevent competing state transitions from creating duplicate roles, final reports or contributions. Schema additions run on database import and are idempotent. Migration refuses conflicting existing rows rather than deleting them. There is no Alembic.

Files use contextual private upload intents, signed PUT and actual-object size/MIME/signature checks on complete. A file is read through `GET /api/files/{id}/content`: access is checked on every request, then nginx fetches the bytes by `X-Accel-Redirect` to its internal `/_storage` (without nginx the backend streams them), so no storage link reaches the browser. Draft material/report attachments stay private. The unscoped `/upload/presigned-url` writer is deprecated and returns 409. Existing guide/PGAS IDs are preserved; `scripts/adopt_legacy_files.py` turns old uploads of the public bucket into file records with their own key and rewrites texts to `file:<id>`. The bucket becomes private at the cutover ([DEPLOY.md](../DEPLOY.md)).

- [Deployment and rollback](../DEPLOY.md)
- [Migration rehearsal and explicit ID mapping](docs/MIGRATION_V13.md)
- [Account archive and scheduled retention](docs/ACCOUNT_RETENTION.md)
- [Additional API contracts and legacy adapters](docs/API_V13_ADDITIONS.md)
- [Testing](TESTING.md)
- [Implementation checklist](docs/CONTINUATION_AUDIT_2026-10-18.md)

A fresh empty installation may bootstrap its initial chair from explicitly configured ADMIN_NAME/ADMIN_PASSWORD. Existing installations require an operator mapping by user ID. Startup never resets an existing password or infers privileges from a name. No deployment, real VK/S3 calls, or production-data migration is performed by unit tests.
