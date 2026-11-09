# VK avatar import

Owner decision, 2026-11-09: import the VK photo for a new account and, on the next
VK login, for an existing account without an avatar. Preserve manually uploaded
photos, selected presets (including an explicitly chosen default) and legacy photos.
This supersedes the earlier no-VK-photo policy; historical migration reports remain
historical and are not rewritten.

`main.vk_login` first verifies the token and commits identity, registration and
session changes. It then schedules `vk_avatar.import_avatar` as a response background
task, passing only the user ID, verified subject and provider `avatar` URL. The
authentication response does not wait for photo I/O. The token and provider URL
are not stored or logged. A failed import is retried only on a later VK login;
process restarts may lose a scheduled task. No schema migration or new API is needed.

The downloader requires HTTPS on port 443 on an allowlisted VK CDN domain, rejects
redirects and non-public DNS answers, pins the selected IP and still verifies the
TLS hostname. Provider query signatures are preserved. Downloads have a 2-second
socket timeout, a 5-second read deadline and a 3 MiB limit. DNS uses the operating
system resolver. Only JPEG, PNG and WebP with matching signatures are accepted.
The dedicated S3 client has 2-second connect and 3-second read timeouts, one attempt.
At most two imports run per worker, with duplicate work for the same user suppressed.

No network I/O holds a database transaction. The importer rechecks the same verified
identity, eligible account state and absence of any chosen avatar before recording
the upload and again before attaching it. A manual choice during the transfer wins.
The file is written create-only to `sealed/<file_id>`, with a normal owned avatar
`FileRecordORM` and `ProfileMetadataORM.avatar_file_id`. Reads retain the ordinary
private `/api/files/<id>/content` access policy; a pending account does not gain new
file-reading rights. Browser/profile reads made before the import finishes may need
a refresh to show it. Neither the external photo URL nor a storage URL reaches clients.

Failed or superseded imports queue object deletion through the existing retention
mechanism, without calling DELETE on storage. A pending import left by an interrupted
process is retired on that user's next VK login after its one-hour expiry. Physical
deletion remains the existing separately authorized cleanup operation.

Verification: `tests/test_auth_vk.py`, `tests/test_vk_avatar.py`, directory/profile and
private-file tests, and `tests/test_integration_http_transactions.py`. Providers are
synthetic in tests. Real VK login and successful delivery from the deployed S3 are
separate deployment checks.
