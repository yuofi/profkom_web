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

Form pickers whose options the server filters read them in one request under one
query key instead of rebuilding them from per-object lists: the merit scopes from
`GET /merits/contexts` (`["merits", "contexts", seasonId]`) and the report series a
new event or subevent may continue from `GET /report-series/continuable`
(`["reports", "series", "continuable", parentEventId]`, reread with `["reports"]`
after every workspace command).

A closed task whose reader may see accounting inputs reads its KKR batch
(`GET /tasks/{id}/accounting-batch`, `["accounting-batch", taskId]`) for the line under
«Учёт работы и ККР». The KKR window reads and saves under the same key: it opens with
the values already read (rereading them in the background) and a save updates the line at once.

Directory-card avatars use native lazy loading so off-screen protected images do
not all start together. The shared Avatar leaves its loading behavior unchanged
unless explicitly selected; primary profile images and editing previews retain
their ordinary behavior. Check both the initial request count and a complete
scroll: delaying an image must not prevent its eventual display.

Search keeps the input and URL immediate while coalescing backend reads. Forward
TanStack Query's AbortSignal through the API helpers and every pagination request,
so obsolete reads can be cancelled. Do not let a late response replace the current
filter result or turn cancellation into access to stale private data.

Pickers over a large readable set search on the server instead of listing it. The
closed-summary corrections page finds its task (or the task of an assignment) with
one `GET /tasks` page: `season_id`, the settled typed `q`, `limit=20`,
`include_facets=false` and `exclude_kkr_control=true`; it never follows cursors and
says when only part of the matches is shown. For assignments it also matches the
typed words against the person and task title of the season's assessments it already
reads for the labels (rows without `assignment_inputs` or an evaluation are never
offered), after the server's matches and once per assignment. EntityPicker's
`onSearch` mode does not filter those matches again, keeps the chosen option's label
when a later search no longer returns it, and Enter does not choose while the search
is still loading. A page may pass the chosen values' current options
(`selectedOptions`), which win over that kept label: the corrections page rebuilds the
chosen assignment's label from the assessments it reads, so after a correction its chip
names the saved hours and evaluation.

The season participant summary mounts at most one decision editor. Closed row
disclosures contain no ActionForm or Formik subscriptions. Switching participant,
closing the editor or changing a participant filter uses the participant panel's
unsaved-change scope: save, explicitly discard, or stay. Sorting preserves the
active participant identity. Successful saves retain the existing summary-version
checks; opening or filtering the table never writes a decision. Exercise repeated
row visits as well as the initial form count when checking responsiveness.

Do not read layout while a fresh page commits. The season tabs take their first
sizes from ResizeObserver and bring the current tab out of the fade in the next
animation frame, so mounting a season page does not lay it out before its summary
request starts.

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
