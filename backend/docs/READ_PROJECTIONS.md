# Read projections and request-scoped memoization

Lists and dashboards select lightweight public task facts before building detailed
task DTOs. `task_reads.TaskIndex` batches tracker metadata, current roster/assignment
identities, favorites and scope data. It does not hydrate submissions, checklists,
link trees or assessment inputs to decide which tasks belong on a page.

Visibility remains in `task_queues.readable_tasks`: feedback ownership is the same
reporter exception as `task_read`; existing queues use the central `can_read` policy,
including the support-staff gate before global queue access. The scope fallback is
only for legacy tasks without a queue. Bulk materialization changes neither policy
nor grants. Missing legacy metadata may be repaired only after the original task
ACL admits the reader; a hidden orphan must never be rebound to a public queue.

`tracker.task_page` computes the same authorized facets, filters, total and keyset
cursor over the lightweight selection. Only returned rows use the original detailed
converter, with a fresh current task-read check. The index is not a response cache.
Before conversion, `TaskIndex.prepare` batches the selected page's descriptions,
assignments, roster, submissions, file identities and planning relations. It does
not prepare those details for off-page tasks. The original converters still own
every field, ordering rule, redaction and capability.
Facet semantics intentionally require reading the lightweight candidate set; SQL
pagination is not claimed. Date filtering preserves timestamp parsing and the
existing planning overlap rules instead of comparing mixed-offset strings in SQL.

`workspace.calendar` projects deadline entries directly. `workspace.home` selects
personal work once, reuses it for today's calendar and converts at most five
upcoming and five overdue cards. Management rights never expand the actor's
personal assignee/watcher selection. Counts include the full authorized personal
selection, even when only five cards are shown. Merit links require their original
central actions and no longer need complete member/leader DTOs.

Personal participation uses the ORM event hierarchy and the actor's central
relations directly, without constructing complete leadership cards. Notifications
batch only the task targets actually selected by their dispatch precedence;
report/meeting/PGAS branches never fall through to task access. Unread flags,
ordering, unavailable-target redaction and the support reporter exception remain
unchanged.

Queue catalogue items omit editor-only `assignable_users`; the detailed queue GET
retains the exact authorized candidate list. Editors request that queue explicitly
and must not interpret an empty or denied candidate response as permission to use
the whole contact directory.

## Read scope

`read_context` exists only inside an outer `Database.atomic(write=False)` or
`async_atomic(write=False)`. Session.info holds the scope and a ContextVar lets
existing pure policy/database helpers reuse detached values. Mutable DTOs and
collections are copied; immutable sets/scalars can be reused. Already-loaded ORM
instances are held only until this unit of work exits.

Relation reuse stores immutable `(model, primary-key)` tuples in that same scope,
returns fresh containers and resolves rows through the owning Session. It never
stores shared mutable response DTOs. Task/queue ACL booleans include the input
scope and queue policy fields in their keys, preserving in-memory legacy fallbacks.
Scalar scoped-role/block-identity facts and absent PK reads are reused only within
this clean read unit. Compatibility repairs still disable all of these hints.
Batch preparation must retain the original ordering, including SQLite's legacy
query behavior for multi-row rosters and joint submissions; those cases can keep
their original task-local queries instead of imposing a new ordering rule.

There is no process-wide cache or TTL. Ordinary direct database calls and write
units are uncached. Dirty/new/deleted ORM state, flush, any unclassified/Core/raw
SQL command, transaction boundary or nested write permanently disables the scope.
Lazy compatibility repairs therefore disable caching too. Core/driver commands
expire unchanged loaded ORM attributes after execution; primary keys, pending edits
and the ORM's own flush state are preserved. Rollback never resurrects memoized
permissions. A copied async context cannot use a scope after its owner has closed.

### Request-scoped facts

`read_context.snapshot` returns one immutable whole-table fact map for a clean read
unit and `None` everywhere else; callers then run their original per-object query.
`access` evaluates the same rules over role assignments, legacy blocks, block
metadata (name↔id), subevents/organizers, subevent HR owners and leadership, so
`relations`/`scope_relations`, `block_name`, `membership.legacy_name`/`block_id_for`
and `profile_features` need a constant number of statements per request. A
missing block metadata row still takes the original read-repair path, which
disables the scope. `database._role_rows` keeps SQLite's rowid order for leaders and
deputies. Scalar facts are read by `database.scalar_rows` as one JSON aggregate row:
the SQLite driver hands the GIL over on every fetched row, so whole-table row
fetches made parallel requests (for example the merits page's per-event subevent
reads) several times slower even when one request alone was not. After twelve
distinct people in one request, `_prime_people` loads users with contacts and
profile metadata in one row per person, plus avatar file rows (absent rows
included), for the unchanged `_user_to_ref_dc`/`avatar_url`/`contact_data`
converters; smaller detail requests keep their individual reads. Measure parallel
bursts as well as single requests when changing these thresholds. Task ACL batches
reuse the TaskIndex rows, prefill refused control grants and the reader's queue
memberships; `readable_tasks_many` records decisions for several readers (assignee
and actor) of one selection. `report_access.historical_reader` compares series
first, checks leadership against the actor's role snapshot (no statement per
series instance) and memoizes per request. Every value lives only in its unit of
work: a dirty object, flush, command or transaction boundary discards it.

Never cache a live ORM object with detached-value helpers. Never bypass support,
private queue, current membership/leadership, KKR or access_revision checks to
reduce query counts. Refusal and immediate permission revocation remain part of
the contract.

## Write units

Write units stay uncached: permissions and relations are evaluated as before. The
unit only holds strong references to the rows it loaded or flushed until it ends
(`read_context.hold_identities`), so repeated `session.get` calls of one command
use the identity map instead of reloading weakly referenced rows.

Before a unit of work opens, `auth.precheck_access_token` refuses a missing,
malformed, expired or wrongly signed access token with the same 401 the session
guard gives, without SQL; the guard itself reads the session account in a worker
thread (`anyio.to_thread`) and sets `actor_id` in the request's own context.
Register, change-password and temporary-password (`auth.OWN_TRANSACTION`) hash
the password outside the shared write lock and repeat their checks in a short
`db.atomic()` afterwards. A write unit that waited for or held the write lock for
more than `database.WRITE_LOCK_LOG_MS` (200 ms) logs both durations on the
`profkom.write_lock` logger. An idle support-worker or material-retention tick
reads in a read unit and opens no write transaction.

`read_context.Calculation` keeps values for one calculation while its session is
clean and its generation is unchanged; any change, flush or Core/driver command
drops them. `pending_ok=True` (comment fan-out) also tolerates pending new rows
while their count is unchanged, never modified or deleted rows. On top of it:

- `tracker.TaskFacts` materializes one task's rights for one command response, so a
  PATCH or assignment command builds its DTO once.
- `task_queues.ReaderFacts` computes a reader's account state, support queue id,
  staff gate, global-reader flag and global relations once per `readable_tasks`
  call. The facts reach `can_read` through a context variable; module-level
  `can_read(session, queue, uid)` stays the decision seam. `readers_of` decides
  every candidate reader of one task (comment fan-out) with one shared
  calculation and falls back to `task_read` at any change.

Notification fan-out scans `access.holders(actions, kind, scope_id)`: a superset of
the users any rule of those actions can relate (leadership, HR masters, block
masters and role holders, event/subevent parent and child roles, organizers, HR
owners, report series and parent series instances, frozen report editors). The
existing ACL still decides each candidate, in users-table order; a relation the
superset cannot enumerate (block members, "leads some queue") returns `None` and
the original full scan runs.

KKR control reconciliation (`kkr_control_hooks`) reads its inputs in batches
unless rows of those types are dirty, links a closed task directly to its scope's
control epic (falling back to the full season sync whenever that is not provably
the same), resets only the title cache for title-only event/subevent changes and
skips accounts without roles, mastership or chairmanship and material-editor roles.

## Season summaries

A calculation-local materialization batches participant/contact/avatar/archive,
membership/leadership, contribution and evaluation facts for a season. A fresh
materialization is built for each calculation, including commands; it is not a
write-unit permission cache and is never shared across requests or subsequent
mutations. The avatar batch uses the same public avatar policy as individual
directory reads.

The coefficient catalog decides its reader's edit capability once per listing.
A closed summary's correction reads the season's contributions once (grouped per
participant in the per-participant order) and the evaluated-task counts in one
grouped query; rows, ranks and the version step are unchanged. Season-close
blockers read assignees, the actor's task readability (`readable_tasks`) and final
reports in batches with unchanged blockers and private-queue masking.

Summary source masking passes the complete lightweight task selection to the
central batch task ACL once. Support, private queues, managed controls, individual
grants and current permission loss retain their ordinary policy. Wire conversion
resolves current stable block metadata in a batch without read-repair. Approved
snapshot amounts and ranks remain frozen; refreshing live avatar presentation
does not recalculate historical numbers.

## Verification

`tests/test_task_read_projections.py` checks detail parity, full authorized facets,
keyset pages, deadline windows, no off-page hydration, the ten-card home bound,
purged participant masking, unchanged private accounting and hidden legacy repair.
`tests/test_request_read_context.py` checks request isolation, mutable-result safety,
same-request revoke/dirty state/Core and driver writes, rollback, copied contexts,
lazy repair and SQL count reduction. Queue batch ACL parity includes private grants,
support ownership/staff restrictions, unavailable users and pending metadata.
Write-path parity: `tests/test_write_identities.py`, `test_command_responses.py`,
`test_reader_facts.py` (batch vs per-task policy, comment fan-out),
`test_notification_holders.py` (holders contain every full-scan reader over several
unclosed seasons), `test_reconcile_scope.py` (scoped vs full queue and KKR
reconciliation), `test_readiness_batch.py` and `test_summary_recompute_batch.py`.

Performance comparisons must reuse one synthetic database snapshot, actor, request
and source manifests. Measure uninstrumented wall time separately from SQL/profile
passes; request-local instrumentation must exclude lifespan/background cleanup.
Local TestClient improvements are not deployed/WAN/browser measurements.
