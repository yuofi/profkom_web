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
Facet semantics intentionally require reading the lightweight candidate set; SQL
pagination is not claimed. Date filtering preserves timestamp parsing and the
existing planning overlap rules instead of comparing mixed-offset strings in SQL.

`workspace.calendar` projects deadline entries directly. `workspace.home` selects
personal work once, reuses it for today's calendar and converts at most five
upcoming and five overdue cards. Management rights never expand the actor's
personal assignee/watcher selection. Counts include the full authorized personal
selection, even when only five cards are shown. Merit links require their original
central actions and no longer need complete member/leader DTOs.

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

There is no process-wide cache or TTL. Ordinary direct database calls and write
units are uncached. Dirty/new/deleted ORM state, flush, any unclassified/Core/raw
SQL command, transaction boundary or nested write permanently disables the scope.
Lazy compatibility repairs therefore disable caching too. Core/driver commands
expire unchanged loaded ORM attributes after execution; primary keys, pending edits
and the ORM's own flush state are preserved. Rollback never resurrects memoized
permissions. A copied async context cannot use a scope after its owner has closed.

Never cache a live ORM object with detached-value helpers. Never bypass support,
private queue, current membership/leadership, KKR or access_revision checks to
reduce query counts. Refusal and immediate permission revocation remain part of
the contract.

## Verification

`tests/test_task_read_projections.py` checks detail parity, full authorized facets,
keyset pages, deadline windows, no off-page hydration, the ten-card home bound,
purged participant masking, unchanged private accounting and hidden legacy repair.
`tests/test_request_read_context.py` checks request isolation, mutable-result safety,
same-request revoke/dirty state/Core and driver writes, rollback, copied contexts,
lazy repair and SQL count reduction. Queue batch ACL parity includes private grants,
support ownership/staff restrictions, unavailable users and pending metadata.

Performance comparisons must reuse one synthetic database snapshot, actor, request
and source manifests. Measure uninstrumented wall time separately from SQL/profile
passes; request-local instrumentation must exclude lifespan/background cleanup.
Local TestClient improvements are not deployed/WAN/browser measurements.
