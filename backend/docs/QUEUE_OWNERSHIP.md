# Automatic queue ownership recovery

A queue keeps its current owner while that account is active, approved and still
has underlying read access. Ownership grants private-queue read, but never bypasses
the block/subevent scope ACL. Losing a leadership role alone is not a transfer if
the person still reads the scope through another valid membership or role.

When the owner is archived, banned, purged or loses scope access, the next owner is:

1. The block's actual `master_user_id`, only for a block-scoped queue.
2. The actual `master_user_id` of a configured `is_hr` block.
3. The current `Leadership.chair_user_id`.

Candidates must themselves be active, approved and able to read the underlying
scope after ownership is assigned. Duplicate candidates are skipped. Independent
and subevent queues skip the block-master tier. Deputies, legacy admin/super_user
flags, names and FIO matching are never fallback identities.

If no candidate exists, the unavailable historic owner ID is retained. No arbitrary
person receives the queue, and the old owner gets no management bypass. Readable
queue DTOs expose `owner_unavailable: true`; locked catalogue projections do not
reveal this field, the owner, scope or transfer details. A later real leadership or
account change can recover the queue. Restoring a former owner after a completed
transfer never automatically returns ownership.

## Atomicity and history

`queue_ownership.install_hooks()` is installed after normal database startup
migrations. It marks ORM account/membership/role/leadership/scope changes, including
ORM bulk UPDATE/DELETE, and reconciles only at the actual outer Session commit.
Nested domain `_SessionLease.commit()` calls merely flush and cannot transfer a
queue halfway through archive. Final flush and identity expiration make current
ACL checks observe the same transaction, including bulk commands that deliberately
did not synchronize their ORM identity map.

A transfer changes only `TaskQueue.owner_user_id` and its queue revision, plus one
private AuditLog record containing IDs, automatic/manual marker and recovery tier.
The real triggering actor is used when available; actor ID 0 represents a system
startup repair. Existing session access_revision already fingerprints queue owner
and revision, so both old and new clients invalidate private caches. Membership,
roles, grants, task workflow, roster, private inputs, KKR, dates, contributions and
immutable summaries are not changed by recovery. Any failure rolls back the owner,
audit and triggering account/membership command together.

`reconcile_existing()` performs one idempotent startup repair of old invalid or
ownerless rows after schema migration. It does not infer historical dates or
actors. GET handlers only project current availability and never repair or write
ownership. Out-of-band raw SQL should use the normal domain commands or an explicit
repair during a separately authorized maintenance operation; it is not silently
repaired on a subsequent GET.

No new table, endpoint or background/external service is required. Existing
owner-only PATCH can still explicitly transfer an available queue; it also records
the actual actor in AuditLog. Automatic recovery is an exception for unavailable
ownership, not a new management permission for all queue readers.
