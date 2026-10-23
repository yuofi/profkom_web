# Rehearsing API 1.3 migration

Work on a filesystem/SQLite-backup copy first. Do not copy a database with an active WAL using a plain file copy; use SQLite's backup API or stop writes. Keep the original and record its SHA-256. Import-time schema additions are idempotent; duplicate planned/current seasons, role assignments, contributions or final reports stop the integrity-index installation instead of silently deleting rows.

```sh
cd backend
python scripts/migrate_v13.py --database /absolute/copy.db --report /absolute/dry-run.json
python scripts/mapping_candidate.py --database /absolute/copy.db --out /absolute/ids.json --review /absolute/review.json
python scripts/migrate_v13.py --database /absolute/copy.db --apply --mapping /absolute/ids.json --report /absolute/mapped.json
```

Dry-run and the candidate use `mode=ro` and do not import the app. Apply runs the existing additive startup migrations, then the mapping, and records counts, quick_check, stable block IDs and the sections below. Repeat apply on the same copy and verify counts/source text hashes, IDs and accounting: a repeat only adds the audit record of the repeated mapping. Rollback means restoring the whole backup and matching application version, not trying to drop individual columns.

## The report

- `unresolved` — what the operator still has to map or accept, by IDs. After apply it is the current state of the database, so a later mapping shows up in it (A-DIR-17); `initial_report` keeps what the first apply found, with its time. The dry-run computes the same sections from the schema of the old site.
  - `chair_missing`, `legacy_super_user_ids`, `legacy_admin_ids`: map `chair_user_id`.
  - `hr_block_missing`, `hr_block_candidates`: map `hr_block_id`.
  - `vk_only`: accounts without a password and without a VK identity, with the VK ID their saved link or `vk_<id>@vk.com` address names and the evidence. `vk_id_shared`: a VK ID named by more than one account.
  - `email_case_groups`: accounts whose addresses differ only in case. The unique index on `lower(email)` is installed on the first start without such pairs.
  - `unmapped_blocks`: blocks without a master, with the legacy master string and the accounts of that name.
  - `incomplete_user_ids`: `users` rows without contacts; they become `pending` and get no participation interval.
  - `ambiguous_vk_copy`: accounts with signs of the old VK login whose photo is the bucket object. The old VK login copied the VK photo there, an own upload looks the same.
  - `without_documented_participation`: approved accounts whose participation is only observed from the migration.
- `applied_mapping` — the mapping of this run, IDs only.
- `categories` — the categories by the rule below (dry-run: the plan).
- `guides` — blocks with an own guide and blocks with a placeholder.
- `schema` — columns and indexes of the current code the database lacks; empty after a complete migration.
- `migrations` — what each step recorded when it ran.

Open the site only when `unresolved` is empty or its rest is accepted by the owner. For release 1 the owner accepted: `unmapped_blocks` (masters, deputies and HR curators are assigned by hand after the release, УВ-1), `without_documented_participation` (tenure is not invented, decision 36) and `ambiguous_vk_copy` as far as the operator does not reset photos (decision 34).

## The mapping

An explicit, secret-free mapping file can contain:

```json
{
  "chair_user_id": 123,
  "deputy_chair_user_ids": [456],
  "hr_block_id": "stable-block-uuid-from-the-first-report",
  "block_masters": [{"block_id": "stable-block-uuid", "user_id": 789}],
  "vk_identities": [{"vk_user_id": "verified-numeric-vk-id", "user_id": 123}],
  "participation_intervals": [{"user_id": 123, "started_at": "2026-01-01T00:00:00Z", "ended_at": null}],
  "categories": [{"user_id": 123, "category": "junior", "reason": "Joined this season"}],
  "reset_avatars": [123]
}
```

`scripts/mapping_candidate.py` writes a candidate with what the data proves unambiguously: the only legacy `super_user` as chair (АВ-16, a temporary chair), the only block named HR, and the VK ID the old VK login saved for an account without a password. Its review file lists the rest: accounts without a VK ID, shared or conflicting VK IDs, pending accounts. Check every entry before use: the saved link is what the old site wrote, not a proof of ownership of the VK account.

Use verified IDs and documented historical dates. Unknown dates stay unknown and do not earn historical tenure. The migration observes an approved account and its current memberships from the migration onward (`memberships.observed_since`, joined_at stays null); a roster row of an account approved later is observed from the approval. Earlier tenure requires documented operator input. Names, emails, old admin/super_user flags and events_roles never produce new domain roles. Existing saved master_user_id is a trusted explicit mapping. Existing pgas_admin remains a separate PGAS permission. A VK identity may be mapped to a pending account too: the old VK login created accounts before their approval. Never match FIO or email automatically.

A VK login whose VK ID a current account names in its saved link, while no account holds that identity, answers 409 (`vk_link_required`) and creates no second account until the identity is mapped. A VK ID that no account names signs in as a new pending application, as before.

Categories (decision 36): the approved accounts of the old site, which called all of them activists, become `activist`; the others stay `junior`. Only the accounts that got the default of the new `users.category` column change, each with an audit record. Memberships of a confirmed roster become `member` («Участник» of the block); rows of pending accounts stay `junior`. `categories` in the mapping corrects a person, with a reason in the audit log.

`reset_avatars` (decision 34) replaces a possibly copied VK photo by the standard avatar: the saved link is cleared, an adopted file of that old key is detached, a photo chosen since then stays. The bucket object is not deleted.

A fresh, empty installation may create one initial chair from explicitly configured ADMIN_NAME/ADMIN_PASSWORD (minimum 12 characters). Startup never resets passwords and never elevates an existing account by matching the configured email. Existing installations must map the initial chair by ID. Guide seeds preserve existing titles/content and create mapped materials.

Migration preserves old guide IDs/texts/PGAS references. New materials use canonical Markdown and explicit guide_id-to-material_id mapping. Existing owned photos stay; VK URLs become a local preset without fetching images. Closed summaries retain frozen categories/rosters/bonus recipients; later corrections create immutable versions.

After copy rehearsal: run backend regression, local HTTP/frontend integration, confirm `/session` capabilities and object access, test private S3 PUT/HEAD/GET and bucket CORS in the deployment environment, and verify VK provider credentials. Those external checks and deployment itself are separate operator actions. Retention scheduling is described in ACCOUNT_RETENTION.md.

## Order for the database of 6eb9dea

1. Stop the old API, back up the database with the backup API, record its SHA-256.
2. Dry-run and candidate on the copy; review the candidate and the review file.
3. Apply with the reviewed mapping, then apply again; compare the reports.
4. `repair_storage_links.py --apply`, `adopt_legacy_files.py` (dry-run, then `--apply`), `seal_completed_files.py --apply` (calls the storage).
5. Check `unresolved` and `schema`, start the new API.

## Completed files cutover

Uploads now use `private/file_id` only as staging; served bytes are create-only
`sealed/file_id` objects. Before opening an upgraded installation, stop the old
API and seal all completed records with `scripts/seal_completed_files.py`.
This avoids leaving old publications mutable until their first new read.

`python scripts/seal_completed_files.py --database /explicit/copy.db` is a
read-only count/quick_check: no application import, schema writes or storage
calls. Rehearse apply against synthetic data/storage first. With separately
approved target environment and backups, `--apply` seals completed objects;
failures abort visibly, rerunning preserves already sealed objects. Verify
conditional PutObject support before cutover. File IDs and SQLite schema stay
unchanged. Lazy sealing on read remains a compatibility fallback; it cannot
recover a historical overwrite before the first seal. Previously issued URLs
retain their provider TTL; they are never reused by the upgraded file API.

Running against real storage/data is a separate approved operator action. This
project's local checks exercise only the synthetic database and storage doubles.
