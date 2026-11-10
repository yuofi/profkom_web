# Public tracker and private accounting

Current contract, reviewed 2026-11-01. The owner-approved iteration of
[2026-10-30](../../docs/decisions/2026-10-30-portal.md) supersedes the older public
workflow; the owner decisions of [2026-10-31](../../docs/decisions/2026-10-31-qa-audit.md)
narrow closed-season changes and support-ticket sharing. This document describes
current behavior; legacy routes are adapters, not a second permission model. See also
[planning](TRACKER_STAGE2.md) and [comment attachments](COMMENT_ATTACHMENTS.md).

## Public workflow and permissions

`TaskTracker.status` uses four values: `open`, `in_progress`, `completed`, `closed`.
`tracker_status.py` normalizes old aliases without rewriting private Assignment
outcomes or historical activity. Every current reader may move between the first
three states. Only the current readable author closes/reopens; if the author is
missing, inactive or no longer has access, the queue owner is the audited fallback.
Managed KKR control tasks cannot be manually changed.

`POST /api/tasks/{id}/status` uses the public `expected_revision`.
`POST /api/tasks/{id}/submit-result` requires actual text/link/file content and
records the real submitting actor/time; legacy `submitted` maps to `completed`.
Public status commands reject private assessment/evaluation fields. Changing a
working status never acknowledges or overwrites private accounting.

Block tasks may start without a season (owner, 2026-11-10). Closing one requires
an explicit season: a missing value answers 409 `task_season_required` without
changing status, dates, revisions, notifications or KKR. A close command may carry
`season_id` for a block task that has none; placement and closure then commit
together at the same public revision. Seasonless support tickets keep their existing
closure workflow and never receive an invented accounting season.

The task capability `assign_season` belongs to current public editors or the person
currently entitled to close the seasonless block task. `PATCH /tasks/{id}` accepts
the first `season_id` with `expected_revision`, advances the public and private-input
revisions and records a public season change. Planned, open and summarizing seasons
can be selected; closed seasons cannot. The task's dates, parent, children and both
directions of task links must remain compatible. Incompatible links must be removed
explicitly; a mixed parent removal/first placement is atomic. There is no automatic
transfer of linked tasks or KKR. Clearing or changing an already assigned season
requires the existing administrative correction workflow. Preparing hours/criteria
does not create KKR; assessment outcomes and contributions require a season.

`POST /api/tasks/{id}/take` atomically self-assigns the current reader, removes their
watcher role and sets `in_progress`. A direct status choice never self-assigns.
Repeated satisfied commands are idempotent; stale revisions roll back.

The site calls neither `take` nor `submit-result` (owner 2026-11-08, В6): there are no
«Взять в работу» and «Сдать результат» buttons, support tickets included. A result is
written in a comment; the task's «Результаты работы» section shows only results already
submitted. Both endpoints and the `take_task`/`submit_task_result` capabilities remain
for earlier clients and tests.

A reader and an assignee have the same base public rights: read, change ordinary
working status, submit a result, toggle checkmarks, edit any comment, self-join/watch.
These roles alone do not authorize description, type, priority, planning or
checklist-text edits. Metadata belongs to the author, queue owner and existing
authorized public editors, subject to current scope/season restrictions. Actual HR
masters and deputies have global public task-edit authority in non-closed seasons,
including foreign/private queues; in the HR block the HR deputy is also an ordinary
block deputy.

A closed season is changed only by the chair, the deputies and the HR master
(`CLOSED_SEASON` in `access.POLICY`): public task fields, review, assessment inputs and
dates, merits and summary corrections. The HR deputy and area leads make none of these
changes there, the HR block included. A new assignment row in a closed season (join,
take, assign, reassignment; rule `task.add_assignment`) is added by the same circle;
others get 409 `season_closed` on join/take and 403 on assign/reassign, while a former
assignee who still owns a row may rejoin. Reader controls are not narrowed: in a closed
season every reader still changes the public status, submits a result, ticks checklist
marks and comments; none of these changes accounting. Closed independent tasks also
keep the creator/queue-owner exception for public fields.

Markdown checkmarks use the conservative `/description-checklist` command: only
recognized checked flags may change, not arbitrary text or code examples. Structured
checkmarks have a separate strict item toggle. Neither expands description-edit rights.

## Private accounting and revisions

Public task status, roster and public revision remain separate from Assignment
outcome, hours, evaluation, dates, TaskInputs and private revisions. Private edits do
not leak their notes/criteria/values into public history or silently move public status.
Current scope/season roles govern accounting; actual HR deputies share global
KKR/summary/analytics authority, without unrelated report/event-management privileges
and without closed-season changes.

After observed public closure, the unified accounting editor saves common task
criteria plus all assignee rows atomically. `accounting_batch.py` validates every
revision and private right; a bad later row rolls back the whole command. The criteria
are exactly the keys of `database.KKR_CRITERIA_TABLE`: an unknown key or a missing one
is 422. A stored key the table does not name is ignored (`criteria_flags`), so a record
carrying one equals the same choice without it and gets no new revision or audit entry.
The automatic deadline premium is the only urgency; no criterion adds to it. New
accounting uses the actual server closure time. Unknown legacy dates are never
reconstructed. Deadline-free tasks receive no urgency premium or lateness penalty.

`AssessmentInputs.revision`/`workflow_revision` and
`TaskTracker.assessment_revision` version private fields. A real visible deadline
change also advances the public task revision/history. Closed corrections use a
reason and acknowledge the revisions returned by their write transaction, not a
later GET. Approved numeric snapshots stay immutable except versioned correction.

Compatible private review URLs retain their own workflow/source guards. Like the
batch, `accept`, `not-complete` and `PATCH /assignments/{id}/assessment-inputs`
answer 409 `task_not_closed` until the task is publicly closed (a reopened task
included); the right is checked first, and a closed season's corrections are exempt
(SE-12, owner 2026-11-01). `request-revision`, `cancel` and bulk hours are not gated. Legacy
acceptance without an effective completion date requires an observed submission or
an authorized explicit date; it cannot invent `now`. See
[analytics and coefficients](SEASON_ANALYTICS.md) for the distinction between private
weekly trends and closed-work source statistics.

## Queues, sources and access

Queue removal is logical and revision-protected: the catalogue and new-task choices
omit it, while existing tasks, accounting, direct queue links and owner-managed grant
revocation remain available. Chair/deputies, HR master, scoped masters/responsibles,
the explicit owner and service account may remove a readable ordinary queue; KKR and
support queues are protected. See [QUEUE_DELETION.md](QUEUE_DELETION.md) for migration,
default-queue recreation, retained ACL, pending requests and rollback semantics.

New queues always bind to an accounting source. Block masters/deputies may create
in their block; main-event heads/deputies in their event (default) or its children;
subevent responsibles/deputies in their subevent; chair/deputies may choose any
source or stable chair work `chair`. Ordinary readers cannot create queues. Old
unscoped queues are compatibility data, not a supported new source choice; explicit
rebinding preserves history and never guesses source identity from personal names.

A queue has an immutable unique key `^[A-Z][A-Z0-9]{0,31}$`: an uppercase ASCII letter,
then uppercase ASCII letters or digits (owner 2026-11-08, В9; the create form turns lower
case into capitals, the server does not). `KKR` and `WEBSUPPORT` are reserved (409
`control_queue_conflict` / `queue_key_conflict`). Task numbers advance monotonically
within a queue. Existing UUID URLs stay valid. Scope ACL and private-queue
owner/grant checks govern reading. An approved explicit queue grant works without
ordinary team membership, and never grants private accounting/report authority.
Chair/deputies and actual HR master/deputy read ordinary queues globally. The
WEBSUPPORT queue and managed KKR controls have stricter dedicated gates.

A queue has no season of its own (owner 2026-11-08, В8). A granted queue DTO (item and
catalogue) carries its place: `scope_title` (the team), `season` `{season_id,title,state}`
for event/subevent queues (the event's season) and a `task_creation` hint
`{available,reason}` that repeats the `POST /tasks` rule: event/subevent while the event
season is planned or open (`season_summarizing`, `season_closed`), chair while a
season is open (`no_open_season`), block independently of seasons, legacy unscoped while one is planned or open
(`no_season`), `team_missing` for a vanished scope. KKR and WEBSUPPORT get `null`. The
hint is advice for the UI; `POST /tasks` still decides. The catalogue loads all places
of a page in a fixed handful of queries.

For a block queue, `POST /tasks` accepts an omitted or null `season_id`. An explicit
season may be planned, open or summarizing. An archived block gives the creation
hint `block_archived` and rejects new tasks and queues, while its existing queues
and tasks retain history and access. A pending/scheduled block removal does not
close its queues early. Event/subevent, chair and historical unscoped queues retain
their earlier season requirements.

The UI (variant В, owner 2026-11-08, item 19) shows the place as the team's chip and a
season pill coloured by `state` (open mint, planned lilac, summarizing peach, closed grey,
linking to the season) beside the queue's title and in the catalogue's «Команда и
сезон» column. When `task_creation.available` is false, a reader with `create_task`
keeps «Создать задачу» in the toolbar as an `aria-disabled` button whose click only
focuses it: a few words beside it (`queueCreationShort`; up to 1320 px wide and on a phone
they take their own line under the toolbar, so the search keeps its width), the full reason
(`queueCreationNotice`) as its description and in a hint on hover, keyboard focus or a tap.

A locked catalogue entry exposes only safe ID/name/key and the viewer's own request
state, not scope/team/season/owner/people/tasks/counts. Requests can be cancelled; the owner
approves/rejects or revokes. Replaying an old approval cannot restore a revoked grant.
Session `access_revision` includes current role, ownership, privacy and grants.
Ownership recovery is described in [QUEUE_OWNERSHIP](QUEUE_OWNERSHIP.md); GET never
repairs ownership or makes a queue readable as a side effect.

Every ordinary queue reader can create a task, including an unassigned one. Initial
selection of other people and private inputs requires the corresponding capability;
ordinary creation cannot forge hours/criteria or manufacture membership.

## Roster, mentions and comments

`TaskRoster` stores assignee/watcher/left roles independently of private outcomes.
A current reader may self-join or watch; authors/public editors manage other people.
Removing an assignee converts them to a watcher and preserves accounting. A watcher
may unwatch themselves. Rejoin reuses the person's accounting row rather than adding
duplicate credit. Mutations use task revisions and publish only safe roster diffs.

Any commentator may explicitly summon an active approved user. Existing readers are
notified directly. An outsider requires author OR queue-owner approval before the
notification and a revocable single-task grant. A WEBSUPPORT ticket is shared only by
support staff: its author, unless staff, gets no `manage_task_access`, and approve,
reject and revoke answer 403, while the author keeps the reader's join/take/submit
actions. The grant opens public task content,
comments, files and ordinary actions, not the queue, hidden relations, KKR or reports.
All singular/batch/file reads recheck revocation; self-join cannot elevate the grant.

Comment responses include safe `mentioned_users` for canonical relative profile
links. Archived/unavailable people render inert placeholders. Writing a link itself
never notifies anyone. The editor tracks intent only for targets explicitly inserted
in the current draft; deleting/untagging their token removes that pending intent.
Old links in an edited comment never become implicit notification recipients.

The composer has one Markdown frame with source/preview and a footer people picker
and paperclip. Comments have their own attachment bindings and `purpose=comment`
upload context. See [COMMENT_ATTACHMENTS](COMMENT_ATTACHMENTS.md) for preserve/remove
semantics, foreign-file refusal, private drafts and history metadata. Files do not
become instruction attachments. Failed saves retain the draft; upload blocks submit.
Current comments and the task attachment tab share the same comments query.

Whoever may comment (`tracker.can_comment`: every current reader, closed seasons and
control epics included) may also tick a comment's checklist and delete a comment
(owner 2026-11-08, V4/V5; `task_comments.py`). `POST /comments/{id}/checklist` takes
`expected_body`, a UTF-16 `offset` and a strict `checked`: another current body is 409
`comment_changed` unless it is exactly this mark (a lost-answer repeat), a non-marker is
403 `checklist_only`. The comment is not marked edited and gets no version snapshot; the
activity `comment_checklist_toggled` («Отмечен пункт «…» в комментарии», the item as
plain text: link text without its target, no emphasis or code marks, up to 80
characters) carries the `comment` before/after. `DELETE /comments/{id}` (204,
repeatable) soft-deletes with `deleted_at`/`deleted_by_user_id`: no placeholder, the
comment leaves the list and the attachment tab, its files leave the task unless a live
comment still binds them, its pending mention requests become `cancelled`. One pending
request serves every comment that calls the person, so it instead moves (revision + 1)
to the first live comment written or edited since the request that still links the
person; access already granted by an approved mention stays. Earlier entries keep
their visibility and `comment_deleted` («Комментарий удалён») names who deleted it, with
the last text as `before`. Editing, marking or re-creating (GL-07 key) a deleted comment
is 404 `comment_deleted`. Notifications already sent still open the task. The UI puts
«Редактировать» (a pencil) and «Удалить» (a trash can, in the danger colour) in the comment's
«⋯» menu. Deletion asks once more in the comment's own header (owner 2026-11-08, В5):
«Удалить комментарий? Удалить / Отмена» stands in place of «⋯» and the comment fades until
answered; Escape or «Отмена» return to «⋯», and after the deletion the focus moves to the
neighbouring comment.

## Files, hierarchy and history

Instruction attachment drafts use task-owned contexts and public-editor rights.
Creation binds completed uploader-owned drafts atomically; foreign, wrong-purpose,
already-bound and incomplete files fail with full rollback. Shared result files use
current task-read rights. Every complete/read/download rechecks the appropriate ACL.
Completed files use verified sealed bytes; storage URLs are not returned to users.

Parents may come from any readable queue in the same season. Self-links/cycles and
season corrections that split a linked hierarchy are rejected. An unreadable parent
is masked in both current DTOs and diffs; an unrelated edit preserves its stored link.
The page shows queue NAME > parent > current key, or queue NAME > current key.

Activity exposes observed public before/after values and the actual actor. New
comment changes include attachment diffs with safe names; old events without
snapshots do not invent values. Private notes/inputs/KKR and raw audit stay excluded.
Safe current UserRefs preserve anonymization. Hiding historical text retains a
tombstone and never restores removed attachment bytes or rewrites numeric accounting.

## Persistence and verification

Migrations preserve UUIDs, numbers, prior outcomes, credit, immutable snapshots and
unknown dates. Repeat imports do not create duplicate rows or fabricated activity.
GET paths do not seed accounting controls, calculate scores or repair hidden tasks.

Focused tests include `test_tracker_reader_policy.py`, `test_tracker_iteration.py`,
`test_tracker_control_guards.py`, `test_comment_mentions.py`,
`test_comment_attachments.py`, `test_comment_commands.py`, `test_tracker_queues.py`, `test_kkr_iteration.py`,
file/history/migration regressions. Fixtures
and services are synthetic; current test names and precise commands are listed in
[TESTING](../TESTING.md).
