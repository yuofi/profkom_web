# Workspace read paths

Page modules retain the existing React.lazy/Suspense boundaries with dedicated
entry points for reader and editor routes. Loading one route must not import
every route or its editors. Editor-only result submission,
Markdown and attachment controls stay behind their explicit user actions and local
Suspense boundaries. Keep public/auth-only modules out of the protected entry
graph when a protected page does not use them.

The confirmed session is the authorization boundary. Pending/rejected accounts
and forced password changes cannot start workspace queries. After an active,
approved session, the personal profile and independent page data may load in
parallel. Own profile routes still wait for that record before mounting, because
their forms take initial values from it. Account changes and access revisions
retain the existing private-cache invalidation and refusal behavior.

Fetch filter-option catalogues when the options are opened or their selected
values are needed. Use the shared task-queue catalogue key, distinct from a queue
detail. Calendar/Gantt reads every required planning page; it must not also fetch
an unused ordinary task page. A small facet query may run when its filter panel
needs those facets. Errors from active queries still hide refused data.
On an access revision, inactive cache eviction includes queries with disabled
observers, not just queries with zero observers. Opening a previously closed
filter must never briefly render options from before the permission change.

Directory-card avatars use native lazy loading so off-screen protected images do
not all start together. The shared Avatar leaves its loading behavior unchanged
unless explicitly selected; primary profile images and editing previews retain
their ordinary behavior. Check both the initial request count and a complete
scroll: delaying an image must not prevent its eventual display.

Search keeps the input and URL immediate while coalescing backend reads. Forward
TanStack Query's AbortSignal through the API helpers and every pagination request,
so obsolete reads can be cancelled. Do not let a late response replace the current
filter result or turn cancellation into access to stale private data.

## Measuring changes

Compare one frozen synthetic database and source manifest, with the same roles,
viewport, navigation mode and readiness condition before and after. Record first
observed requests separately from repeated samples. A loading marker disappearing
and route-specific data appearing are more useful than an arbitrary network-idle
delay; include the next paint and disclose any server-side instrumentation.

Hard document loads and in-app navigation are different scenarios. Playwright
request routing disables normal HTTP cache, even when requests continue: repeated
hard loads under that guard are not evidence of warm browser-cache performance.
Label simulated latency, local HTTP, test-server loopback and owner-network
measurements separately. Browser viewport emulation does not measure phone CPU.
