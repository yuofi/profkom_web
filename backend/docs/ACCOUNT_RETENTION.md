# Account archive and retention

Only the current chair can archive/restore accounts. The legacy DELETE profile command delegates to archive. Transfer the chair first. Archive retains a private assignment snapshot, closes participation/membership intervals and revokes access and refresh tokens. Restore opens new intervals; it does not backdate service. A conflicting master position requires `{block_id, keep_user_id}`. A deputy chair from a previous chair term never returns automatically. Archived accounts cannot authenticate or read the working site.

Former-contact cards are separate records without an account FK; editing requires tachki or the HR master. Create/update the agreed card explicitly before retention cleanup. Cleanup does not infer consent or copy a private account into the public directory.

Run from `backend/` with a backup and an explicit database path:

```sh
python scripts/cleanup_accounts.py --database /srv/profkom/data/profkom.db
python scripts/cleanup_accounts.py --database /srv/profkom/data/profkom.db --apply
```

Without `--apply` the CLI opens SQLite in read-only mode and does not import startup migrations. `--as-of 2029-10-19T00:00:00+00:00` supports deterministic rehearsal. Eligibility is archived_at plus three calendar years, inclusive; February 29 becomes February 28. Restored accounts are excluded; a later archive starts a new retention period.

Example daily UTC cron, installed by the deployment operator (not installed by this task):

```cron
17 2 * * * cd /srv/profkom/backend && /srv/profkom/venv/bin/python scripts/cleanup_accounts.py --database /srv/profkom/data/profkom.db --apply >> /var/log/profkom-retention.log 2>&1
```

Cleanup removes credentials, contacts, identities, registration data and avatar metadata, redacts saved JSON author references and replaces the accounting participant ID with a random anonymous ID. A disabled internal user tombstone preserves non-null historical FKs; it cannot be restored. Numeric accounting, tasks, reports, revisions and separate agreed former-contact cards survive. Summary snapshots allow identity redaction for retention while their accounting values remain unchanged.

Avatar object deletion uses a durable retry queue after the database transaction. The scheduled command drains it; S3 failure returns an error and the next run retries pending keys. It never fetches VK images. External own-photo URLs outside the configured bucket are not remotely deleted. The operator must also set backup retention/access controls; database cleanup cannot erase existing backups or revoke URLs of objects previously made public. A private bucket/CORS rollout is a separate deployment check.
