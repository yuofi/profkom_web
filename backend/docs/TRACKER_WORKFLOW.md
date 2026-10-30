# Public tracker and private accounting

> Current contract (approved 2026-10-30): see [ITERATION_20261030.md](ITERATION_20261030.md).
> Four working statuses replace the earlier eight-status public UI. Readers and
> assignees change working status, comments and checkmarks, but do not edit metadata.
> Only the task author (or the recorded fallback queue owner) closes/reopens work.
> Actual HR deputies now have global KKR/summary authority; reports remain separate.
> New queues require an authorized leader and a block/event/subevent/chair source.
> Atomic accounting is entered after closure and uses an observed server closure
> timestamp, without inventing legacy dates. Task-only mentions require approval
> for outsiders and confer no queue/private-accounting rights. Managed KKR controls
> and WEBSUPPORT keep their stricter service boundaries.
>
> The implementation notes below describe the earlier compatibility design; where
> they differ, the approved iteration contract and current regression tests apply.

A task has one public workflow and shared result history. Personal accounting outcomes,
hours, evaluations and effective completion dates are separate. `tracker.py`,
`task_roster.py` and `task_queues.py` own these boundaries.

## Public workflow

`TaskTracker.status` is authoritative. Every current task reader may choose any of the
eight public statuses, including returning to `assigned` (Открыта), including in a
closed season. Changing public status never changes an Assignment accounting outcome,
inputs, completion date, contribution, summary or personal workflow revision. Public
acceptance without a result is valid and creates no fictitious submission/date/score.

`POST /api/tasks/{id}/status` uses the task's public `expected_revision`.
`POST /api/tasks/{id}/submit-result` uses the same revision, requires actual text/link/
file content and records the real submitting actor/time. A real result also chooses
public `submitted`; it does not itself acknowledge accounting completion. Optional
result fields on the compatible status route behave identically. Public endpoints
reject private evaluation/assessment values.

Public Assignment DTOs project the task's common status for current assignees, saved
public statuses for historical rows, and persisted public revisions. They never expose
new private review notes. Private corrections do not change public DTOs, status,
revision, update/sort timestamp, capabilities or task history. Do not reaggregate raw
`Assignment.status` after the migration baseline.

## Private accounting

Existing scope/season roles still govern inputs, evaluations, date overrides and
formal private decisions. HR deputy's global tracker read gives no unrelated KKR,
report, meeting, event-management or summary rights. Independent tasks have no
invented block/subevent accounting source and expose no accounting controls.

AssessmentInputs `revision`/`workflow_revision` version the private record; its
`workflow_status` is the private Assignment outcome. Existing private review URLs and
private reassignment use that private version. Every successful formal decision moves
it, including a note-only/same-outcome decision, so old notes cannot overwrite a newer
review. Private notes remain in authorized accounting/audit storage.

A positive authorized evaluation may acknowledge the latest actual shared/legacy
submission timestamp when no effective completion date exists. It may not invent
`now`, override an existing date or bypass the original date-override permissions.
Without an observed submission or an authorized explicit date it is rejected.
TaskInputs have a separate `TaskTracker.assessment_revision`; private criteria/issue-date
changes do not advance public task revision/history. A real visible deadline change
advances both relevant versions and public history. Closed corrections acknowledge
these private revisions from their write transaction.

Unresolved accounting queues and season readiness use private outcomes, not freely
editable public statuses. A public terminal status cannot dismiss unfinished accounting;
private finalized accounting may coexist with an open public task. Independent tasks
are excluded from accounting readiness and evaluated-task counts. Numeric ledgers,
bonus rules, prior approved snapshots and role restrictions remain intact.

## Queues, access and creation

Every active approved user may create a queue and is its initial owner. A queue can
belong to a readable block/subevent or be independent (`Queue.scope=null`,
`Task.scope={kind:'queue',id:queue_id}`). Public independent queues are readable by all
active approved users. Ordinary scoped queues retain their original scope read ACL;
private scoped queues additionally require ownership/a current approved grant.
Chair, chair deputy, HR master and HR deputy read every queue and its tasks, including
private ones. Other scope masters retain scoped access. Global read does not imply
queue management: requests/ownership/privacy remain with the current owner.

Unique queue keys contain only uppercase ASCII letters and are immutable. Task keys
use per-queue monotonic numbers; original task UUID URLs remain valid. The approved
catalogue's locked projection shows only ID/name/key and the reader's own access-request
status, with no scope/owner/people/tasks/counts. Requests, decisions and revocations are
durable, internal-only and never create block/event membership. Replayed old approvals
cannot restore a revoked grant. Session access_revision fingerprints role/global-read,
owner/privacy and membership/grant changes for cache invalidation.

Every queue reader may create a task, including with no assignees. Ordinary creation
can assign/watch only the creator and cannot forge private hours/criteria (defaults
0/false remain valid). Original authorized scoped leads may initially select other
active readable teammates; the queue exposes those safe assignable UserRefs only
under that capability. Independent queues do not invent team membership or KKR roles.
Task creator and queue owner may edit public title/parent/attachments in addition to
existing scope editors; current assignees may edit description. Scoped closed-season
public field freeze is retained except for original authorized chair roles. Independent
public field editing has no accounting freeze. Comments retain their original author;
task author/current assignees/original comment author may edit with actual editor
recorded in public history.

The current master of the configured HR block is also a global public task editor
in non-closed seasons, including other blocks, subevents and independent/private
queues. The central `task.edit` policy grants title/Markdown-description editing and
the corresponding public editor controls; Markdown checkboxes use that same guarded
description PATCH. This does not transfer queue ownership or change any accounting,
report or analytics permission. The HR deputy retains global tracker reading and
ordinary reader controls, without a new global editing or private-accounting grant.
Closed scoped tasks remain editable only by the chair/deputies. Closed independent
tasks retain the existing creator/queue-owner exception; HR role alone does not bypass it.

## Real roster and watcher subscriptions

`TaskRoster` records assignee/watcher/left roles independently of private outcomes.
Every task reader may add themselves as an assignee or watcher. Every task reader may
remove any current assignee, which converts that person into a watcher. A watcher may
unwatch themselves. Joining an assignee already present or watching an existing
assignee/watcher is idempotent. Assignee wins over duplicate initial watcher selection.
All mutations use task expected_revision and record public assignee/watcher diffs.

Removing/rejoining a person preserves previous hours, evaluations, dates, outcomes,
credits and audit. Rejoin reuses the person's existing accounting row rather than
creating duplicate credit. Public assignment revisions advance separately to reject
stale old worker URLs. Private reassignment retains its original unresolved-private-
outcome guard; choosing a public terminal status cannot lock or unlock that operation.
Mine/calendar use current assignees. Actual watchers receive current readable comment/
status notifications and stop after unwatch or loss of access. No external delivery is
performed.

## Files and hierarchy

Task attachment drafts may be uploaded before creation with owner_kind=task and absent
owner_id. Only their active uploader can read/complete them. Task creation atomically
binds completed uploader-owned attachment drafts after queue/role validation; foreign,
already-bound, wrong-purpose and incomplete IDs are rejected with full rollback.
Existing contextual/sealed-byte integrity checks remain. Instruction attachments use
public editor rights; shared result files use current task read rights. Unbound files
stay uploader-only; bytes/download/complete recheck current queue access after binding,
including after grant revocation. Code extensions use canonical text/plain and must be
valid UTF-8 text without binary controls; HTML is never executed by the server.

Parents may come from any readable queue in the same season. Self-links/cycles and
corrections splitting a linked hierarchy between seasons are rejected atomically.
If parent access is lost, its ID/name/key are masked in the child and historical diffs.
Omitting the parent field on an unrelated edit preserves a hidden stored link.

## History, migration and verification

Public activity contains observed public before/after values and the actual actor.
New creation/comment events include real initial values; old events lacking snapshots
return empty changes. Raw audit, private notes/hours/evaluations/reasons are excluded.
Roster IDs are stored without cached personal names; reads resolve safe current
UserRefs/display names and preserve purged-user anonymization.

Additive migrations create default queues, stable numbers, roster/public revision
baselines and private TaskInputs revisions without rewriting UUIDs, old outcomes,
credits, immutable snapshots, dates or invented public activity. Repeating the import
does not renumber tasks or change private/public versions. Legacy mixed snapshots are
preserved as observed baseline; choosing a new public status does not rewrite private
historical outcomes. Missing historical update timestamps remain unknown.

Old individual Database worker/review helpers remain for low-level legacy code;
production compatibility routes use tracker.legacy_command. Worker URLs preserve own/
current-assignment, public revision and old start/resume source guards. Private review
URLs are separate authorized accounting commands.

Tests cover reader statuses/closed seasons, private version/note/date isolation,
roster reuse and stale URLs, watcher subscriptions, creator/self-only/private-input
boundaries, current HR-deputy accounting rights without unrelated report escalation, contextual draft
bytes and queue revocation, migration twice, hierarchy, filtering/cursors, concurrency,
private accounting rollback, season closure and unchanged numeric ledgers/snapshots.

## Comment identities and the editor

The comment editor keeps formatting, source/preview and attachment/mention actions
in one frame. Its file action retains the existing task attachment capability and
does not introduce independent comment-file ownership. Other Markdown contexts keep
their existing editor behavior.

Authorized comment responses may include `mentioned_users`, a bounded batch of
safe public UserRefs for canonical relative `/contacts/<id>` Markdown links.
Comment display and preview use those identities for user chips, rather than
trusting a user-authored link label. Missing, archived or banned targets become
non-interactive unavailable-person chips. Code and foreign links remain ordinary
Markdown. This is presentation only: writing a profile link never notifies anyone
or grants access. The explicit mention command and author/queue-owner approval
continue to control notifications and any revocable single-task grant.

The editor tracks notification intent only for targets explicitly chosen in the
current draft. Removing or untagging their inserted token clears that pending
target; manually typed links and mentions from an existing comment never become
implicit notification recipients. Control reminders include canonical links for
their existing explicit recipients, while retaining the same ordinary mention
notifications, source permissions and repeat behavior.
