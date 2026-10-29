# Account archive and retention

The chair and the deputy chairs archive and restore accounts (release 1 policy, `account.archive`/`account.restore` in `access.py`). The legacy DELETE profile command delegates to archive. Transfer the chair first. Archive retains a private assignment snapshot, closes participation/membership intervals and revokes access and refresh tokens. Restore opens new intervals; it does not backdate service. A conflicting master position requires `{block_id, keep_user_id}`. A deputy chair from a previous chair term never returns automatically. Archived accounts cannot authenticate or read the working site.

Former-contact cards are independent records without an account FK; editing requires the chair, a deputy or the HR master. The first archive creates a snapshot of the contact and the documented participation periods in the same transaction. A nullable unique source ID prevents duplicate snapshots on rearchive; cleanup clears that ID. Existing independent cards are never matched by names or contacts. Their later edits survive rearchive and use `expected_revision` to reject stale writes.

The cleanup implementation has a fail-closed schema registry. Unknown tables, missing module callbacks and malformed registered JSON stop the entire batch before any account is changed. Report Markdown is preserved verbatim, including report versions. Identity replacement uses exact participant IDs and owned fields; it does not replace matching names, ID substrings or free text. Profile, feedback and history modules supply their own typed identity cleanup callbacks. Numeric accounting snapshots, saved versions and historical work remain unchanged.

The report is still available. Run from `backend/` with an explicit database path:

```sh
python scripts/cleanup_accounts.py --database /srv/profkom/data/profkom.db
```

The CLI opens SQLite in read-only mode and does not import startup migrations. `--as-of 2029-10-19T00:00:00+00:00` supports deterministic rehearsal. Eligibility is archived_at plus three calendar years, inclusive; February 29 becomes February 28. Restored accounts are excluded; a later archive starts a new retention period.

`--apply` applies only the database transaction and records owned avatar keys in the durable deletion queue. It makes no storage calls. All selected accounts and module callbacks form one transaction; a failure rolls the entire batch back. Repeating it after a successful cleanup is a no-op. The operator selects an explicit database path and rehearses on an isolated backup before scheduling any live run. No schedule is installed by the application.

Cleanup removes credentials, contacts, identities, registration data and avatar metadata, redacts saved JSON author references and replaces the accounting participant ID with a random anonymous ID. A disabled internal user tombstone preserves non-null historical FKs; it cannot be restored. Numeric accounting, tasks, reports, revisions and separate agreed former-contact cards survive. Summary snapshots allow identity redaction for retention while their accounting values remain unchanged.

Object deletion requires a separate explicit `--delete-pending` invocation, mutually exclusive with `--apply`. It commits completed keys individually: a storage failure leaves the remaining keys pending for retry. Unsealed uploads queue both staging and sealed keys; adopted legacy avatars queue their stored key. Keys shared with other file records or another account's legacy avatar are preserved. Contextual work attachments survive account cleanup. The command never fetches VK images. Of `photo_url`, only an old public avatar key (`avatars/…`, see `legacy_files.legacy_key`) is queued; other URLs are not remotely deleted. The operator must also set backup retention/access controls; database cleanup cannot erase existing backups or revoke URLs of objects previously made public. A private bucket/CORS rollout is a separate deployment check.

Block archive snapshots keep the proved `scope_block_id` across rename and name reuse. Old snapshots without that proof return `archive_scope_mapping_required` and require explicit role-to-block mapping before restore. Old tenure dates and labels are immutable. `scope_tenures.scope_block_id` is nullable for legacy data; a current roster operation closes an unproved active interval and starts a new proved interval at the operation time. Legacy labels do not grant historical authority over a new block that reuses a name.
