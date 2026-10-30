# Portal iteration approved 2026-10-30

This document records the owner's approved contract, including the later queue
clarification. New decisions supersede older reader/status/merit rules. Work is in
the primary checkout only. Preserve CODEX files, the owner's design files and the
original `лого/` images. External actions are limited to the approved push and
update of the test site after local verification; production is not authorized.

## Public tracker and collaboration

- Readers and assignees have the same public rights: read, change working status,
  add/edit any comment, toggle checklist items, self-join/watch. Neither role alone
  grants description, classification, planning or other metadata editing.
- Authors and the existing authorized public editors retain metadata/roster rights.
- Four public statuses: open, in_progress, completed, closed. Only the author can
  close/reopen a closed task; an unavailable/unknown author falls back to the queue
  owner, with audit attribution. Public status remains separate from private KKR.
- Old public statuses map to these four without changing historical events or
  private assignment outcomes, grades, hours or dates. An observed new closure
  has a server timestamp; never backdate unknown legacy closures.
- Any commentator may summon any active approved account. Existing readers are
  notified directly. For an outsider, author and queue owner receive an approval
  request; either may approve. No grant/target notification until approval.
- A special grant opens this task's public content/comments/files/working status,
  not the queue, hidden parents/links, reports or private KKR. Self-join must not
  bypass that grant's permission ceiling. Grants can be revoked explicitly.
- A queue owner's explicit approved grant opens that queue independently of team
  membership. It does not add membership or private accounting/report authority.
- Add cancellation of a pending queue request, owner notification and navigation
  to a newly created queue. Preserve special WEBSUPPORT staff/reporter boundaries.
- Authors/editors can assign another eligible person and remove watchers.
  Removing an assignee makes them a watcher and preserves past private accounting.
- Task creation edits title in the branded header. Remove the help action and
  the explanatory relations sentence. Fix checklist item addition.

## Queue creation and accounting source

- Block masters/deputies create queues in their own blocks.
- Main-event heads/deputies create queues in their event (default) or a child.
- Subevent responsible/deputies create queues in their own subevent.
- Chair/deputies may select any source or the stable chair-work source `chair`.
  Chair-work KKR belongs to the block-work subtotal, not chair special merits.
- These are server-side capabilities and authoritative candidate lists. Ordinary
  accounts cannot create queues. New queues always have a source.
- Event queues need an event-task source with its own season coefficient (default
  1); subevents retain their own coefficients. Chair work is a separate source.
- Existing unscoped queues must be rebound once, explicitly and audibly, during
  synthetic qualification and the test-site update. Preserve all rows/history;
  do not infer relationships from personal names. No production data migration
  is authorized or needed by this iteration.

## Unified KKR editor and control

- Approved layout A: one dialog, common task criteria and a table of assignees,
  one atomic save with all revision checks. Entry fields appear after public
  closure; closing the dialog defers accounting and allows reopening it later.
- Public closure never grants private KKR rights. Keep private rights except that
  actual HR deputies now also have global KKR/summary/analytics authority.
- Effective completion for new unified accounting is the observed task closure
  time, as explicitly selected by the owner, not submission/acceptance time.
- Repair save-and-leave, including all external editor state, failures, stale
  revisions and permission revocation. No partial multi-assignee save.
- Closed seasons retain reasoned, immutable version corrections. Legacy unknown
  dates and old approved numbers are not reconstructed or silently rewritten.
- Private KKR control queue KKR is owned by the current HR master. Create one
  managed epic for each season/source; block masters and subevent responsibles
  are assignees, HR master/deputies observe; event heads also observe children.
  Direct event/chair work must also be covered. Reconcile managed roles safely.
- Link ordinary work with `related`, preserving its existing product epic.
- Control epics stay open throughout the season and close once at season end;
  do not auto-close an empty epic. Missing accounting means hours/grade absent
  without explicit exclusion. Numeric zero is a filled value.
- Seed/reconcile idempotently for existing open seasons and new sources/seasons.
- HR's summon button adds normal mentions to the relevant control tickets. No
  separate duplicate notification and no repetition/cooldown limit.

## Coefficients, summary and analytics

- For a task without a deadline, the owner additionally approved hours × evaluation
  × criteria × source coefficient, with no urgency premium or late penalty.
  The existing dated-task formula is unchanged.
- Coefficients are per season, finite nonnegative values including zero, default 1.
  Editors: chair, chair deputies, HR master and actual HR deputies.
- Each block, main event and subevent has its own work coefficient. Chair-work,
  chair-merit and each main event's head-merit coefficients are separate.
- Weight each raw source once, including negative scores. Compute the existing
  master bonus from raw facts, then apply the block factor once.
- Closed snapshots freeze applicable coefficients and numbers; use the existing
  authorized versioned correction mechanism for closed changes.
- Main season screen is participants/KKR: rank, person, block subtotal, event
  subtotal, total, current marks, previous-season marks. Use compact icon chips.
- Marks save immediately per click in one popup, without a Save button or a
  reason in an open/summarizing season. Closed corrections retain their reason.
- Diagnose mark-save latency separately (server transaction/SQL, response/refetch,
  browser commit); prove improvements with bounded comparable measurements.
- Analytics tabs select blocks/events. Count distinct closed ordinary work tasks,
  excluding control epics; tasks/person uses their assignees. Mean KKR includes
  nonzero negative totals. Person-hours/task uses accepted known hours/accounted
  tasks. Remove the completeness display.
- History defaults to four seasons, configurable count, current name/block/course
  filters, historic rank/total/mark icons; missing facts stay a dash.
- Fourth page shows sources with unfinished accounting. Keep server season-close
  gates for reports/previous seasons/etc, with compact counters and links.

## Merits, events and membership

- All special merit and volunteer entry is limited to chair/deputies and main
  event heads/deputies within their active event, not subevent responsibles or
  block masters/HR solely by those roles. Preserve past records and audit.
- Add explicit main-event closed state. Only chair/deputies can close/reopen it.
  Dates/report publication do not close it automatically. Closed-event heads
  cannot continue awarding merits.
- No self-leave/removal from a block. Removal by block master/deputy, HR
  master/deputy and chair/deputies only. Remove leadership first before removing
  an active master/deputy. Notify actual HR master/deputies, no automatic ticket.

## General interface and assets

- Registrations become compact expandable cards with approve/reject buttons.
  Preserve review permissions and rejection requirements.
- Simplify home: remove completed-work widget, team filters and top duplicate
  links. Existing separate work-accounting routes remain available.
- Contact cards navigate to a participant profile; nested actions stay separate.
  Compact/group current participation, preserve public/private boundaries. Block
  filtering includes actual master IDs, not just ordinary membership strings.
- Remove the applications refresh button, retain automatic refresh, link blocks.
- Move block avatar editing into a header-avatar pencil/popover.
- PDF: continuous scroll, clear rendering at viewport/device scale, bounded lazy
  page rendering; keep protected local bytes and no document scripts/actions.
- Replace unsafe assumptions about crypto.randomUUID in feedback/checklists with
  a shared compatible ID utility. Never weaken secure idempotency generation.
- Use the owner's original PNGs as logo sources without modifying them. КГ means
  Креативная группа (block); День карьеры/ДК is an event, not a block.

## Qualification and delivery

- Focused backend/frontend tests per domain, then full proportional suites and
  disposable HTTP integration. Synthetic desktop/mobile browser verification.
- Rehearse all additive schema changes on synthetic old tables twice. Validate
  rollback, revision conflicts, approval idempotency, privacy and frozen history.
- Keep one source checkout, isolated `.local/env`, unique `.local/logs`; avoid
  owner ports 15173/18000 and stop every verification service after use.
- Commit only task-owned changes, preserving the owner's untracked files. After
  successful checks, push and update test.profcom-cmc.online with a fresh server
  disk preflight, server-only backup, precise artifact hashes and post-checks.
  The owner reports an additional 10 GB disk, but verify actual free space.

## Progress

- [x] Owner's decisions recorded and responsibilities assigned.
- [x] Core models, access policy and API/cache integration.
- [x] Tracker/queues/mentions and frontend integration.
- [x] Unified KKR, coefficients, control epics and season pages.
- [x] Registration/home/profile/blocks/avatars/logos.
- [x] PDF and UUID fixes, event lifecycle and merit permissions.
- [x] Full local qualification and safe legacy queue rebind rehearsal.

The authorized delivery sequence is commit, push to release-1 and test-site update
with server-only backup and rollback. Execution evidence, artifact hashes and the
actual deployed revision are retained under `.local/logs/portal-delivery-20261030/`.
The read-only test inventory found no remaining unscoped queues to rebind.
