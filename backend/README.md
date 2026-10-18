# Profkom Web backend — API 1.3

FastAPI/Pydantic 2, SQLAlchemy 2 and SQLite. Run commands from `backend/`: modules use flat imports. All application routes are under `/api`; current schemas and security requirements are served at `/openapi.json` and `/docs`.

Use Python 3.12, install `requirements.txt` in a virtual environment, configure environment variables from `.env.example`, then run `uvicorn main:app --host 127.0.0.1 --port 8000`. Set an explicit `DATABASE_PATH`; use a disposable path for development/tests. Production requires `APP_ENV=production` and a unique `JWT_SECRET_KEY` of at least 32 characters. Set `FRONTEND_URL` to the actual frontend origin. The Docker image sets production mode; Compose injects `backend/.env` at runtime. Secret files are excluded from the image.

Working content requires an active approved account. Pending/rejected accounts can read/edit/resubmit their own registration. Authentication uses hashed passwords, access-token session versions and rotating single-use refresh tokens; archive, password change and logout-all revoke existing access as well as refresh tokens. VK identities are verified with the provider and linked by an explicit external subject, never by name/email or unsigned claims. VK photos are not fetched.

Roles are explicit assignments: chair/deputies, block master/deputies, event and subevent leaders/deputies, organizers and per-material editors. Legacy admin/super_user/events_roles values are retained as data and do not grant domain rights. PGAS permission remains separate. Backend object checks are authoritative; capabilities project the same permissions for the frontend.

The domain includes versioned seasons and parallel open/planned work; scoped tasks/submissions/help/reviews and historical input corrections; source-specific KKR and frozen summary versions; immutable master-bonus bases; report drafts/publication/versions and saved closed-season editors; meetings, notifications, dashboard/calendar; two-stage block requests; participation intervals/categories; material publication and legacy guide mapping; contacts, local avatars and account retention.

Every HTTP command runs in a single database transaction. SQLite write serialization, revisions and unique indexes prevent competing state transitions from creating duplicate roles, final reports or contributions. Schema additions run on database import and are idempotent. Migration refuses conflicting existing rows rather than deleting them. There is no Alembic.

Files use contextual private upload intents, signed PUT, actual-object size/MIME/signature checks on complete, and temporary GET after current object ACL checks. Draft material/report attachments stay private. The unscoped `/upload/presigned-url` writer is deprecated and returns 409. Existing guide/PGAS IDs and source URLs are preserved; configured-bucket references are resolved to temporary read URLs. Private bucket policy, CORS and expiry of any old public URLs require deployment-side verification.

- [Migration rehearsal and explicit ID mapping](docs/MIGRATION_V13.md)
- [Account archive and scheduled retention](docs/ACCOUNT_RETENTION.md)
- [Additional API contracts and legacy adapters](docs/API_V13_ADDITIONS.md)
- [Testing](TESTING.md)
- [Implementation checklist](docs/CONTINUATION_AUDIT_2026-10-18.md)

A fresh empty installation may bootstrap its initial chair from explicitly configured ADMIN_NAME/ADMIN_PASSWORD. Existing installations require an operator mapping by user ID. Startup never resets an existing password or infers privileges from a name. No deployment, real VK/S3 calls, or production-data migration is performed by unit tests.
