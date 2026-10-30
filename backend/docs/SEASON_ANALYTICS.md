# Read-only season accounting analytics

`GET /api/seasons/{season_id}/analytics` aggregates accounting in one request.
It requires the existing global `summary.view` and `kkr.view` policies: chair,
chair deputies, HR master and actual HR deputies (owner decision 2026-10-30).
This read endpoint does not grant season-management or unrelated report rights.

Optional filters are `participant_id` (stable accounting identity, including
anonymized participants) and `block_id` (the **accounting source block**, not the
person's present membership). A source-block filter selects block tasks, block
volunteering and master bonuses; event/subevent/chair sources are not attributed
to the participant's current block. Options use safe current UserRefs and stable
block IDs. Unknown filter identities return 404 after the role check.

## Metric definitions

- `completed_tasks`: distinct scoped Task IDs with at least one selected privately
  accepted, evaluated Assignment. It is not an assignment count, the old summary's
  evaluated-task count, or a count of freely edited public accepted statuses.
- `credited_hours`: sum of the selected privately accepted Assignment hours.
  Independent queue tasks, rejected assignments and merit hours do not add to it.
  If a selected accepted Assignment has unknown hours the total is null; coverage
  reports the missing count. Missing hours are never converted to zero.
- `kkr`: all selected current contributions or approved snapshot contributions,
  including negative/zero assessments, merits and master bonuses. GET never
  recalculates a contribution or provisional bonus. Unknown scores remain null.

Public task status and roster never drive these metrics. Retired private accounting
rows remain included. Joint tasks count once for an all-participant filter; summing
per-person task counts is not the all-participant distinct task count.

## Time and completeness

`as_of` is UTC. Weekly buckets begin on Monday in Moscow (UTC+3). Hours and task
credits use actual Assignment `effective_completed_at`; merit credits use the
recipient's actual `completed_at`. Bonus credits and records without a proven
timestamp remain `unallocated`. Creation/update/approval times never substitute
for completion dates. Imported naive/invalid timestamps are unknown. Known dates
outside the season are kept in their actual week rather than dropped.

A joint task appears once in the week of its latest selected accepted Assignment
completion if all selected accepted dates are known; otherwise its task count is
unallocated. Individual known hours/credits keep their own dates. Weekly values plus
unallocated values reconcile to known totals. This is a retrospective allocation of
the selected ledger, **not a history of the balance at each past week**.

`coverage` gives accepted-assignment, missing-hours and undated counts, with Russian
UI notes. `source_breakdown` groups KKR by source kind. Missing primary record counts
in summary-only data are null. A legacy saved total without source attribution
remains available while its block allocation is unknown.

## Approved snapshots

Open/planned seasons use current data with `basis.kind=current_ledger`. Closed
seasons select the latest approved immutable SummaryVersion, falling back to the
saved approved SeasonSummary when no version exists. The basis gives its version
and approval time. A missing approved snapshot yields null metrics, not live values.

New approved SummaryVersions embed optional internal `analytics_facts` in
`summary_json`: accepted accounting facts, effective dates and contribution date
allocation, without names/titles/review notes. This is a versioned additive JSON
extension with no schema migration. The version HTTP route strips the internal key.

Existing immutable JSON is never backfilled or rewritten by analytics. Old versions
without facts retain KKR but have null tasks/hours and unallocated credits. Preserving
the initial legacy approval during its first correction also omits analytic facts:
current corrected inputs cannot prove old hours/dates. Only its newly approved
successor captures observed corrected facts. Later raw drift never overrides an
approved version. Recursive account-retention redaction covers participant identities.

Cross-season comparison applies the same filters and bases. GET uses table reads;
it never invokes summary generation, metadata seeding, block ID creation, bonus
recalculation, snapshot creation or audit writes. See `tests/test_season_analytics.py`.


## Source statistics and coefficients (2026-10-30)

The season's main analytics view uses `/seasons/{id}/statistics`: distinct CLOSED
ordinary tasks (excluding service controls), current assignee count, tasks/person,
mean nonzero KKR including negatives, and accepted known person-hours per accounted
task. It is separate from the compatible private-outcome weekly trend above.

`/seasons/{id}/coefficients` stores season-local finite nonnegative factors, default
1, including zero. Blocks, direct main-event work, each subevent, chair work, chair
merits and each event's head merits have independent factors. Raw ledger values
are preserved; weighted source totals and master bonuses apply a factor once.
New approved snapshots freeze applicable statistics, factors and values. Older
unknown facts are not backfilled; closed corrections retain reason/version checks.

`/kkr/history` filters current names, blocks and course while keeping each season's
frozen rank, total and decisions. New statistics/history/control queries share the
normal private-cache revocation and mutation invalidation boundary. The activity
chart and historical version details mount only when explicitly expanded.
