# Shared task workflow

The tracker has one joint task, one shared submission history and one public workflow
status. Individual hours, evaluation and effective completion dates remain separate
accounting inputs. `tracker.py` owns this boundary.

## Authoritative state and privacy

`TaskTrackerORM.status` is authoritative. Do not reaggregate `AssignmentORM.status`
on GET: the latter also carries a private personal accounting outcome. An HR/leader
correction can change that outcome and its `inputs_revision` without moving the public
task workflow, public assignment revisions, `updated_at`, capabilities or history.

`TaskPublic.assignments` projects the common status/capabilities for current participants.
Historical superseded assignments retain their factual public outcome. A separate
`public_statuses_json` snapshot protects legacy mixed and retired assignment statuses
from later private accounting corrections; compatibility checks use this public snapshot
too, so a private evaluation cannot change which public transition is allowed. `TaskPublic.assignees`
is the current safe identity projection for profile chips. Closed/purged users follow
the existing `UserRef` anonymization rule.

A public work action (start/help/resume/submit) changes the task and all current public
workflow revisions together. It preserves a private final personal accounting outcome,
its inputs and contribution. The actor cannot erase HR accounting by starting work.
A review action is separately authorized by `access.POLICY['task.review']`; it may change
personal outcomes and recalculate contributions/summary through the existing helpers.
Hours stay personal. Acceptance defaults fill missing valid positive evaluations;
explicit per-assignment overrides apply where supplied. Requesting revision/cancelling
uses the existing accounting semantics and mandatory reasons.

Current participants exclude assignments with an explicit recorded replacement through
reassign. A retired assignment URL cannot authorize a shared transition, even when its
former assignee later rejoins the same task through a new assignment. Public roster
changes advance the task revision and preserve the canonical workflow status.

Unresolved queues and season-close blockers use the canonical shared status, or the
factual public snapshot for mixed legacy tasks. Their full public capability projection
follows the same rule as Task DTOs: a private correction cannot hide an unfinished task.
Mine selection, calendar and comment notifications use current participants, excluding
explicitly superseded assignments. Private summaries/exports intentionally continue to
use personal accounting outcomes and contribution ledgers.

## API

- `GET /api/tasks`: q (title/key), mine, status, season_id, scope_kind/scope_id,
  unfinished, overdue, assignee_user_id, sort (deadline/updated/created), order,
  limit (default20, 1..100), cursor. The integration harness may lower the effective
  page size. Response includes items, next_cursor, total, authorized scope and assignee
  facets. Cursors bind actor, filters, sort and limit. ACL filtering precedes totals,
  facets, paging and cursor evaluation.
- `POST /api/tasks/{id}/status`: expected_revision, target status, action fields.
  Work actions require a current assignee with current scope access and a non-closed
  season. Reviews use the existing per-scope/closed-season policy. The joint result
  is one `TaskSubmissionORM` with actual submitting actor/time and file references.
  Decisions validate all participants before committing and have one atomic boundary.
- Existing `/api/assignments/{id}/start|resume|request-help|submit|accept|request-revision|not-complete|cancel`
  retain target ownership/current-participation and expected-revision checks, then
  perform the same joint operation. The response remains an Assignment projection.
- `PATCH /api/tasks/{id}` accepts optional file_ids with the existing task-edit revision
  contract, alongside title/description. One command advances one task revision. Failed
  file validation rolls back the other edits as well.
- `GET /api/tasks/{id}/history` requires current task read access. It exposes only typed
  public activity, actor, time and public status transition. It never exposes raw audit
  records, private hours/evaluations/reasons or inferred historical events.

Task metadata also includes task_key (`TASK-N`), author, creation date, known public update
date, scope title, general attachments and the shared submissions. Existing UUID URLs
remain unchanged.

## Task file contexts

Both use owner_kind=task and owner_id=task_id:

- purpose=attachment: task editors upload/attach the instruction files;
- purpose=submission: current eligible assignees upload a joint result.

Unattached completed uploads stay private to their uploader with the corresponding
current write right. Other writers cannot take an unpublished upload. Readers receive
access only after the file is explicitly linked to instruction files or a shared result.
The context/purpose is checked at binding. Removal/scope loss revokes reader access.
The existing verified, sealed-object integrity protocol remains unchanged.

## Additive migration and legacy tasks

Three separate tables (`task_tracker`, `task_activity`, `task_submissions`) preserve legacy
IDs, individual assignments, scores and original payloads. Stable task numbers are seeded
once in deterministic creation/id order. Repeating the import does not renumber tasks.
No past update date or activity is guessed; the factual creation event may be projected
from the original Task record.

Mixed old personal statuses set legacy_mixed_statuses/legacy_status_conflict. The common
legacy projection is explicitly flagged and no personal outcome is overwritten. A joint
command may converge these only when the exact transition is compatible with every
current old outcome; otherwise it fails with legacy_task_statuses409. Explicitly replaced
assignments remain historical and do not block the current joint workflow.

## Regression coverage

`tests/test_tracker_shared.py` checks joint actions and one result, separate personal
inputs, old route ownership/stale revisions, private active/final accounting isolation,
real mocked file bytes and revocation, rollback, scoped facets/search/bounded cursors,
reassignment A→B→A, unresolved/close semantics and importing a pre-tracker database twice.
`tests/test_v13_tracker.py` retains legacy API/domain coverage with the public revision
expectation adjusted to the joint-workflow privacy rule. New routes are included in the
literal authentication/OpenAPI inventory in `tests/test_api_contract.py`.

Old individual `Database` workflow methods are retained as low-level legacy fixture/domain
helpers. No production route calls them: compatibility URLs must keep using
`tracker.legacy_command`, including the separate start/resume source-state guards.

## Queues and task hierarchy

TaskQueue is a separate entity within the original block/subevent scope. Multiple
queues can share that scope. Its unique immutable key contains only uppercase ASCII
letters; TaskTracker stores a per-queue monotonic number and optional parent UUID.
Task URLs continue to use the original UUID. The additive migration creates a public
default queue per existing scope, keeps the old `TASK-N` as a search alias, and does
not invent creation/update dates or rewrite personal accounting/history. Running the
migration twice does not change keys, counters, timestamps, outcomes or credits.

Queue access is the intersection of current original scope access and the queue's
privacy rule. A private queue is readable by its owner and approved active grants.
Chair/HR/scope-lead roles do not bypass privacy. The approved-account catalogue
exposes only a locked queue's ID/name/key and the reader's own request status; it
never exposes scope, owner, task counts or participants. Queue grants never create
scope membership. Requests, decisions and revocations are durable and notifications
stay inside the site. An old approval cannot restore a revoked grant. Session
`access_revision` includes owner/privacy/grant changes, so frontend caches invalidate.

Queue owner transfer requires an active approved scope reader. If an owner later
leaves the scope or is archived, owner management becomes unavailable; recovery
needs an explicit ownership policy. There is deliberately no implicit chair bypass.

Task creation validates both scope permissions and queue access for creator and
assignees. All task/list/unresolved/calendar/dashboard/history/comment/file/
assessment/season-correction paths repeat that intersection. Ledger/summary numeric
credits remain complete; projections of inaccessible task credits mask titles,
assignment IDs and inputs, including XLSX and immutable summary-version reads.
Groups containing inaccessible task sources use generic scope labels; visible
summary labels and immutable snapshots keep their original values.
Season-close blockers continue to block unfinished private work using one generic
queue-level blocker without task titles or assignee identities. Persisted ledger and
approved snapshots remain unchanged by these redactions.

Parents may come from any currently readable queue in the same season. Self-links,
cycles and corrections that would split linked tasks between seasons are rejected
atomically. If access to a parent is revoked, the child remains readable, but its
parent ID/title/key are masked, including historical parent diffs. Omitted parent
fields on an unrelated description edit preserve the stored link.

Current assignees may edit description (including Markdown checkbox toggles) using
the task revision; title/parent/files keep the original editor permissions. The task
author and all current assignees may edit comments, in addition to their original
author. A comment retains its original author; public history records the actual
editor. Structured public diffs are observed before/after values for title,
description, deadline, status, comments, attachments, parent and assignee IDs. Old
activities without saved values return empty changes. Assessment hours, evaluations,
private reasons and raw audit records are never included in public task history.
