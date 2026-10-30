# Tracker planning and grouping

Stage 2 adds public planning metadata, explicit checklist items, task relations and
personal favorites. None of these operations reads or mutates private hours,
evaluations, effective work dates, contributions or approved accounting snapshots.

## Planning

`TaskTracker` has additive fields `task_type` (`task`, `milestone`, `epic`), `priority`
(`low`, `normal`, `high`, `urgent`) and nullable `starts_at`. Existing rows receive
`task` / `normal` / null without invented history, dates or changed task IDs/revisions.
There is no `goals` field or separate goal directory.

The deadline remains the existing task deadline, including its original edit rights.
A planned start must not be later than that deadline. A milestone is a deadline point
and must have null planned start. An epic uses its own explicit start/deadline: member
status/dates/scores do not automatically change the epic or its private accounting.

Creation accepts the planning fields and checklist. The normal versioned task PATCH
accepts planning and checklist fields alongside title/description/parent/attachments.
A mixed update commits atomically with one public revision. Public editors retain
planned-start editing; description editors (including current assignees under the
existing seasonal rules) retain full-checklist editing. Reader classification and
checkmark controls are described below; the other closed scoped-task freezes remain.
Changes appear in public history; private assessment counters remain unchanged.

## Structured checklist

`TaskChecklist` stores stable `item_id`, task ID, text, checked state and position.
PATCH replaces the ordered list. Existing IDs must belong to that task and occur once;
new entries omit `item_id`. Deletion omits an old entry. Limits: 200 items, 1000
characters of trimmed nonempty text per item. Create cannot bind existing IDs.
The diff stores the ordered visible `- [ ]` / `- [x]` text, without internal item IDs.
Existing interactive Markdown checklists stay independent and are not silently imported.

## Relations and membership

POST `/api/tasks/{id}/links` accepts `expected_revision`, `target_task_id` and `kind`:

- `related`: symmetric relation, stored as one canonical pair.
- `blocks` / `blocked_by`: one directed dependency, projected inversely at the other end.
- `epic` / `epic_member`: an ordinary task belongs to an epic; the inverse adds a member
  from the epic page. At most one epic per ordinary task, enforced atomically and by a
  partial unique index.
- `milestone` / `milestone_member`: an ordinary task belongs to a milestone; multiple
  milestones are allowed, with the corresponding inverse view at each milestone.

Membership is separate from the existing traditional parent link. Existing parent
relations are not rewritten when a task type changes. Source members of epic/milestone
relations must have type `task`, targets the corresponding group type. A type edit that
would invalidate a stored membership is rejected until that relation is removed; this
check includes hidden relations without exposing their IDs or titles.

The current endpoint's public editor must read both endpoints. Links may cross readable
queues within the same season. DELETE `/api/tasks/{id}/links/{link_id}` with a task
revision may be performed by a public editor from either endpoint, provided both are
still readable. Adding/removing a relation advances both public task revisions/history
in one transaction; the supplied expected revision checks the endpoint receiving the
command. Duplicate canonical edges are idempotent. Self-links and dependency cycles
are rejected. Dependencies form a separate graph from parent hierarchy and never
restrict the eight freely editable public statuses or create accounting completion.

Task DTOs include readable `links` and reverse traditional `children`. References carry
ID/key/title/type/status/planned dates. Unreadable targets are omitted. History stores
relation IDs only internally and resolves keys at read time; revoked/deleted targets
are replaced with a generic unavailable-task label. No private queue IDs, titles or
cached personal values leak through history, relations, children or favorites.
Season corrections cannot split either a traditional hierarchy or relation between seasons.

## Favorites and views

POST `/api/tasks/{id}/favorite` accepts `{favorite: boolean}`. This is an idempotent,
personal set operation requiring current read access, without public task revision,
history/update timestamp or private assessment changes. Another person's favorite is
never projected. A stored favorite does not grant access after queue revocation.

GET `/api/tasks` retains existing filters/cursor semantics and adds `task_type`,
`priority`, `favorite`, `date_from`, `date_to`, and sorting by `priority` or `starts`.
The date interval is overlap-based: deadline >= lower bound, and planned start (or the
deadline point when absent) < upper bound. Bounds are canonical ISO timestamps; invalid
or reversed windows are rejected. Cursor context includes all filters, sort and user.
Calendar/Gantt consumers exhaust cursor pages for the selected range instead of treating
the first list page as the complete result. Membership access is checked before filtering.

## Persistence and verification

New tables: `task_checklist`, `task_links`, `task_favorites`; three nullable/defaulted
planning columns on `task_tracker`. Startup never derives new accounting values or
fabricates past public events. Tests rehearse an old-schema database copy through two
imports, preserve original column values and private rows, and cover permissions,
version/rollback behavior, inverse links, DAG and grouping constraints, favorites,
revocation masking, date/filter cursors and concurrent epic assignment.

## Versioned classification and reader checkmarks

The 2026-10-30 owner decision narrows classification to task authors and existing
public editors. Being a reader or an assignee alone no longer grants type,
priority, description, planning or checklist-text editing. The separate strict
checkmark actions below remain available to every current reader. Mixed PATCHes
validate every field atomically and do not grant private accounting rights.

A type-only change to `milestone` still clears its planned start in the same public
revision/history. Existing grouping constraints and `task_type_conflict` remain.
Managed KKR controls cannot be manually classified, linked, unlinked or selected
as a product parent/epic; their ordinary-work relations are server-maintained.

`toggle_task_checklist` is available to every current reader. The dedicated POST
`/api/tasks/{task_id}/checklist/{item_id}/toggle` accepts only `expected_revision` and a
strict boolean `checked`. It updates one already-existing item, retaining its ID, text
and position. Same-value commands are idempotent without a new history/revision; stale
revisions are rejected even for same-value commands. A missing/foreign item or lost task
access is 404. Full checklist CRUD/text/reordering retain `edit_task_checklist` and the
original description-editor/closed-season rules. Neither quick control changes private
accounting or private input revisions.
