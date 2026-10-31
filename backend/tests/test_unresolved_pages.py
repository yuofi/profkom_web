"""GET /assignments/unresolved chooses its keyset page before building DTOs.

The reference is the former algorithm: every authorized assignment converted by
the original per-object path (no read UOW), then sorted and sliced by the same
cursor, each row naming its task's public status (task_status, here read one task
at a time). Each HTTP page must be byte-for-byte that slice for
every reader, filter and cursor, while the converters run only for the returned rows.
"""
import json
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event

import api_contract
from database import db, engine, AssignmentORM, FileRecordORM, SubmissionORM, UserORM
from membership import set_membership
from test_v13_tracker import work  # noqa: F401


@contextmanager
def sql_calls():
    statements = []
    def count(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", count)


@pytest.fixture
def unresolved(client, work, make_user, superuser):
    w = work
    people = [make_user() for _ in range(5)]
    for person in people:
        with db.atomic():
            with db._session() as s:
                set_membership(s, person.user_id, w["block"]["block_id"], True, superuser.user_id, "Synthetic team")
    deadline = datetime.fromisoformat(w["payload"]["deadline_at"])
    tasks = []
    for index in range(9):
        assignees = [dict(user_id=people[(index + k) % len(people)].user_id, hours=1 + k) for k in range(1 + index % 3)]
        payload = {**w["payload"], "title": f"Нерешённая {index}", "assignees": assignees,
                   # Equal deadlines are ordered by assignment id; one task has none.
                   "deadline_at": None if index == 4 else (deadline - timedelta(days=index % 3)).isoformat()}
        r = client.post("/api/tasks", headers=w["master"].headers, json=payload)
        assert r.status_code == 200, r.text
        tasks.append(r.json())
    stamp = datetime(2026, 10, 1, tzinfo=timezone.utc).isoformat()
    with db._session() as s:
        first = s.query(AssignmentORM).filter_by(task_id=tasks[0]["task_id"]).first()
        second = s.query(AssignmentORM).filter_by(task_id=tasks[1]["task_id"]).first()
        s.add(FileRecordORM(file_id="file-unresolved-proof", owner_kind="task", owner_id=tasks[0]["task_id"],
                            purpose="submission", name="proof.pdf", mime_type="application/pdf", size_bytes=7,
                            uploaded_by_user_id=first.assignee_user_id, state="completed", created_at=stamp, expires_at=stamp))
        for n, (row, at) in enumerate([(first, stamp), (first, stamp), (second, stamp),
                                       (second, datetime(2026, 10, 2, tzinfo=timezone.utc).isoformat())]):
            s.add(SubmissionORM(submission_id=f"sub-unresolved-{n}", assignment_id=row.assignment_id, submitted_at=at,
                                text_json=json.dumps({"body": f"Результат {n}"}),
                                files_json=json.dumps(["file-unresolved-proof", "file-missing"] if n == 0 else []),
                                links_json="[]", created_by_user_id=row.assignee_user_id))
        # One assignee is archived and one left the team: both stay listed as unavailable.
        s.get(UserORM, people[0].user_id).account_state = "archived"
        # Tasks in other public states name them (task_status).
        from database import TaskTrackerORM
        for task, status in ((tasks[2], "help_required"), (tasks[5], "submitted")):
            s.query(TaskTrackerORM).filter_by(task_id=task["task_id"]).one().status = status
        s.commit()
    with db.atomic():
        with db._session() as s:
            set_membership(s, people[1].user_id, w["block"]["block_id"], False, superuser.user_id, "Left the team")
    return dict(w, people=people, tasks=tasks, superuser=superuser)


def reference(uid, cursor=None, limit=None, **filters):
    """The former route: convert the whole list, then sort and slice it."""
    import main
    import membership
    from database import TaskTrackerORM
    from tracker_status import public_status
    items = db.list_unresolved_assignments(current_user_id=uid, **filters)
    page = api_contract.cursor_page(items, lambda u: (u.deadline_at or "", u.assignment.assignment_id), cursor, limit=limit)

    def task_status(task_id):
        with db._session() as s:
            row = s.query(TaskTrackerORM).filter_by(task_id=task_id).one_or_none()
            return public_status(row.status) if row else "open"
    return {"next_cursor": page.next_cursor, "items": [
        main.UnresolvedAssignmentOut(
            assignment=main._to_assignment_public_out(u.assignment), task_id=u.task_id, task_title=u.task_title,
            season_id=u.season_id, scope=membership.scope_out(u.scope), deadline_at=u.deadline_at,
            task_status=task_status(u.task_id), **membership.scope_display(u.scope)).model_dump(mode="json")
        for u in page.items]}


def traverse(client, actor, **params):
    pages, cursor = [], None
    while True:
        query = {**params, **({"cursor": cursor} if cursor else {})}
        r = client.get("/api/assignments/unresolved", headers=actor.headers, params=query)
        assert r.status_code == 200, r.text
        pages.append(r.json())
        cursor = r.json()["next_cursor"]
        if not cursor:
            return pages


@pytest.mark.parametrize("filters", [{}, {"orphaned_only": True}, {"season": True}])
def test_pages_equal_former_full_list_slices_for_every_reader(client, unresolved, monkeypatch, filters):
    w = unresolved
    monkeypatch.setattr(api_contract, "PAGE_SIZE", 4)
    params, db_filters = {}, {}
    if filters.get("orphaned_only"):
        params["orphaned_only"], db_filters["orphaned_only"] = "true", True
    if filters.get("season"):
        params["season_id"] = db_filters["season_id"] = w["season"]["season_id"]
    readers = [w["superuser"], w["master"], w["member"], w["outside"], *w["people"]]
    listed, statuses = 0, set()
    for actor in readers:
        if client.get("/api/assignments/unresolved", headers=actor.headers, params=params).status_code == 403:
            continue
        cursor = None
        for page in traverse(client, actor, **params):
            assert page == reference(actor.user_id, cursor=cursor, **db_filters)
            cursor = page["next_cursor"]
            listed += len(page["items"])
            statuses.update(item["task_status"] for item in page["items"])
    assert listed > 8
    # The pages compare task_status across more than one public state.
    assert "open" in statuses and len(statuses) > 1, statuses


def test_scope_filter_pages_match_reference(client, unresolved, monkeypatch):
    w = unresolved
    monkeypatch.setattr(api_contract, "PAGE_SIZE", 3)
    with db._session() as s:
        stored = s.get(AssignmentORM, w["tasks"][0]["assignments"][0]["assignment_id"])
        from database import TaskORM
        scope_id = s.get(TaskORM, stored.task_id).scope_id
    pages = traverse(client, w["master"], scope_kind="block", scope_id=scope_id)
    cursor = None
    for page in pages:
        assert page == reference(w["master"].user_id, cursor=cursor, scope_kind="block", scope_id=scope_id)
        cursor = page["next_cursor"]
    assert sum(len(p["items"]) for p in pages) > 3


def test_limit_and_total_are_optional_additions(client, unresolved):
    w = unresolved
    full = client.get("/api/assignments/unresolved", headers=w["master"].headers).json()
    assert set(full) == {"items", "next_cursor"}
    page = client.get("/api/assignments/unresolved", headers=w["master"].headers, params={"limit": 2, "include_total": "true"}).json()
    assert page["items"] == full["items"][:2] and page["total"] == len(full["items"]) and page["next_cursor"]
    rest = client.get("/api/assignments/unresolved", headers=w["master"].headers,
                      params={"limit": 100, "cursor": page["next_cursor"]}).json()
    assert page["items"] + rest["items"] == full["items"]
    assert client.get("/api/assignments/unresolved", headers=w["master"].headers, params={"limit": 0}).status_code == 422
    assert client.get("/api/assignments/unresolved", headers=w["master"].headers, params={"cursor": "broken"}).status_code == 422


def test_unavailable_reasons_and_tied_submissions_keep_their_values(client, unresolved):
    w = unresolved
    items = client.get("/api/assignments/unresolved", headers=w["master"].headers).json()["items"]
    reasons = {i["assignment"]["assignee"]["user_id"]: i["assignment"]["assignee_unavailable_reason"] for i in items}
    assert reasons[w["people"][0].user_id] == "archived" and reasons[w["people"][1].user_id] == "left_scope"
    orphaned = client.get("/api/assignments/unresolved", headers=w["master"].headers, params={"orphaned_only": "true"}).json()["items"]
    assert orphaned == [i for i in items if i["assignment"]["assignee_unavailable_reason"]]
    with_files = [s for i in items for s in i["assignment"]["submissions"] if s["files"]]
    assert [f["name"] for f in with_files[0]["files"]] == ["proof.pdf", "file"]


def test_page_cost_does_not_grow_with_the_whole_list(client, unresolved, monkeypatch):
    w = unresolved
    monkeypatch.setattr(api_contract, "PAGE_SIZE", 2)
    with sql_calls() as statements:
        r = client.get("/api/assignments/unresolved", headers=w["superuser"].headers)
    assert r.status_code == 200 and len(r.json()["items"]) == 2 and r.json()["next_cursor"]
    submissions = [x for x in statements if "FROM submissions" in x]
    # One batched read for the page (plus the original query for tied rows at most).
    assert len(submissions) <= 2, submissions
