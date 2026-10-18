# Rehearsing API 1.3 migration

Work on a filesystem/SQLite-backup copy first. Do not copy a database with an active WAL using a plain file copy; use SQLite's backup API or stop writes. Keep the original and record its SHA-256. Import-time schema additions are idempotent; duplicate planned/current seasons, role assignments, contributions or final reports stop the integrity-index installation instead of silently deleting rows.

```sh
cd backend
python scripts/migrate_v13.py --database /absolute/copy.db --report /absolute/dry-run.json
python scripts/migrate_v13.py --database /absolute/copy.db --apply --report /absolute/migrated.json
python scripts/migrate_v13.py --database /absolute/copy.db --apply --mapping /absolute/ids.json --report /absolute/mapped.json
```

Dry-run uses `mode=ro` and does not import the app. Apply runs the existing additive startup migrations and records counts, quick_check, stable block IDs and unresolved identities. Repeat apply on the same copy and verify counts/source text hashes, IDs and accounting. Rollback means restoring the whole backup and matching application version, not trying to drop individual columns.

An explicit, secret-free mapping file can contain:

```json
{
  "chair_user_id": 123,
  "deputy_chair_user_ids": [456],
  "hr_block_id": "stable-block-uuid-from-the-first-report",
  "block_masters": [{"block_id": "stable-block-uuid", "user_id": 789}],
  "vk_identities": [{"vk_user_id": "verified-numeric-vk-id", "user_id": 123}],
  "participation_intervals": [{"user_id": 123, "started_at": "2026-01-01T00:00:00Z", "ended_at": null}]
}
```

Use verified IDs and documented historical dates. Unknown dates stay unknown and do not earn historical tenure. A separate migration observation records that an approved account/current membership existed from the observation timestamp onward, so future seasons accumulate verified participation; joined_at remains null. Earlier tenure requires documented operator input. Names, emails, old admin/super_user flags and events_roles never produce new domain roles. Existing saved master_user_id is a trusted explicit mapping. Existing pgas_admin remains a separate PGAS permission. VK accounts without a saved external ID need verified operator mapping or an authenticated explicit `/auth/vk/link`; never match FIO or email automatically.

A fresh, empty installation may create one initial chair from explicitly configured ADMIN_NAME/ADMIN_PASSWORD (minimum 12 characters). Startup never resets passwords and never elevates an existing account by matching the configured email. Existing installations must map the initial chair by ID. Guide seeds preserve existing titles/content and create mapped materials.

Migration preserves old guide IDs/texts/PGAS references. New materials use canonical Markdown and explicit guide_id-to-material_id mapping. Existing owned photos stay; VK URLs become a local preset without fetching images. Closed summaries retain frozen categories/rosters/bonus recipients; later corrections create immutable versions.

After copy rehearsal: run backend regression, local HTTP/frontend integration, confirm `/session` capabilities and object access, test private S3 PUT/HEAD/GET and bucket CORS in the deployment environment, and verify VK provider credentials. Those external checks and deployment itself are separate operator actions. Retention scheduling is described in ACCOUNT_RETENTION.md.
