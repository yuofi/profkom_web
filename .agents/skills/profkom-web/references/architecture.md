# Architecture and domain invariants

Use the current source/tests when a recorded detail disagrees. This repository is the live project; sibling export/archive copies are out of scope.

## Runtime and ownership

React/Vite -> nginx -> same-origin `/api` -> FastAPI -> SQLite and contextual S3 I/O. FastAPI creates one `/api` router in main.py; domain modules register their routes on it. OpenAPI remains `/openapi.json`.

- database.py owns legacy/core ORM, additive import-time schema upgrades, conversions, synchronization and Database.atomic. domain_models.py registers normalized extension tables on the same Base before create_all.
- models.py contains internal dataclasses; main.py and domain_contract.py define HTTP schemas. New domain services may return validated dictionaries rather than legacy dataclasses.
- access.py projects capabilities from current domain permissions. registration, membership, participation, season_summaries, season_corrections, report_access, materials, directory, accounts and workspace own their corresponding workflows.
- auth.py owns passwords, JWT/session versions, refresh rotation and the central approval guard. vk_auth.py verifies provider data and explicit external identities; it never downloads a VK photo.
- file_access.py owns contextual uploads, actual-object verification and current ACL. Uploads target private/file_id staging; complete verifies a bounded GET snapshot and conditionally creates sealed/file_id with IfNoneMatch=*. Completed downloads/avatars use only sealed keys. Before cutover, batch-seal old completed IDs with scripts/seal_completed_files.py while the old API is stopped; its default dry-run is read-only and does not import settings or call storage. Lazy sealing on first read remains a compatibility fallback without a DB schema change; retention queues both keys. Provider support for conditional server-side PutObject is a deployment check. legacy_files.py resolves saved configured-bucket references at read time.

## Authorization and identity

All working content requires an active approved account, including blocks, legacy guides, files and contacts. Public auth operations do not expose content. Pending/rejected users have their own registration/session workflow. Backend checks remain authoritative even when UI buttons are hidden.

Chair/deputies come from explicit leadership/role assignments. Block master, per-principal deputies, event/subevent leaders and organizers grant scoped rights. The master of the explicitly configured is_hr block has global HR/KKR rights; an HR deputy does not. Material editors are assigned per general material by tachki. PGAS rights remain separate.

Never infer rights from FIO, kkr_name, legacy admin/super_user flags or events_roles. A saved trusted master_user_id or explicit operator-ID mapping is different from matching a display name. VK subject links are explicit; provider email or FIO cannot authenticate an existing local account. Password change, archive and logout-all revoke existing access/refresh sessions. Role changes are checked from current DB state on every request. Session access_revision also fingerprints ordinary block membership and subevent organizer rosters; the frontend removes private cache and remounts its observers when access changes. Session is checked on focus and every 60 seconds.

## Transactions, IDs and history

Every HTTP command uses one unit of work. The async HTTP dependency uses Database.async_atomic: writers await a local lock and SQLite BEGIN/commit/rollback run outside the event loop; synchronous services/scripts retain Database.atomic. Keep ContextVar propagation and rollback intact. Nested Database operations flush instead of independently committing. SQLite BEGIN IMMEDIATE serializes writes; revisions and unique indexes cover competing planned/current seasons, roles, contributions, final reports, summaries and memberships. Invalid bulk commands roll back completely. Do not bypass synchronization helpers with ad-hoc roster writes.

Block IDs are stable UUIDs mapped to legacy names in BlockMeta; internal legacy task/role/source storage still uses names in some tables, so use membership boundary conversion helpers. Renaming must preserve IDs and update coupled internal names. Master/deputy service roles are independent from ordinary membership.

Registration applications have a bounded resubmission history. Block requests have separate HR/block stages and server-owned 72-hour clocks. Membership and active/approved participation intervals drive category promotion; scores do not imply tenure. Unknown imported dates remain unknown. A separate observed-state migration records participation from its observation timestamp onward, enabling future tenure without backdating a legacy join.

Closed summary versions freeze participants, categories, master recipients, bonus bases and the previous-summary version. Corrections are atomic and versioned. Report publication/version history is independent of KKR. Closed report editors are saved actual leaders/deputies; removed authors get no fallback right. Current corresponding-series leadership grants published historical read, not draft/edit or past tracker access.

Materials separate shared draft and published content. Legacy guide IDs/texts and PGAS references survive explicit adapters. Current contact writes are owner-only; former cards are independent records edited by tachki/HR. Avatars use local presets or a completed owned file. Draft attachments remain private until publication.

Archive preserves inactive assignments, closes intervals and revokes sessions. Restore resolves occupied master positions and never resurrects global roles from a previous chair term. After three calendar years, retention replaces account identity with an anonymous accounting participant, preserving agreed former cards and numeric history. Avatar deletion uses a retry queue after the DB transaction. Internal disabled tombstones preserve historical non-null FKs; do not physically delete an account through HTTP.

## Migration and deployment

Startup migrations are idempotent, but can reject conflicting legacy rows. Rehearse on a backed-up copy using scripts/migrate_v13.py; dry-run must not import the app or write schema. Privileged/VK/HR mappings use verified IDs; never guess historical dates. See backend/docs/MIGRATION_V13.md and ACCOUNT_RETENTION.md.

The backend Docker image runs Python 3.12 in production mode and excludes secret files. Compose injects backend/.env at runtime. Production requires a unique JWT secret; empty-install chair bootstrap uses explicit configured credentials and never resets/elevates an existing account by email. Private bucket ACL/CORS, provider credentials, actual image build and deployment need environment-specific verification.

Frontend uses shared CSS Modules/tokens, TanStack Query, Axios single-flight refresh and focused API modules. API 1.3 types are in utils/api/contract.ts; legacy adapters remain in types.ts. Development demo mode is separate from real-local API integration and disabled in production. Old unscoped upload is deprecated; use filesApi intent/upload/complete.

Versioned ActionForm holds the editing baseline across refetch, including a lossless revisionKey vector for bulk/closed commands. Own sibling commands may advance only a matching from->to baseline. Markdown and attachment replacement must reset external state together with Formik. Closed summary correction returns applied_revisions from its write transaction; never silently accept a newer GET revision as the command acknowledgement.
