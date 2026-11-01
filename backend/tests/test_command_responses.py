"""Tracker command answers: one DTO, one calculation's access facts, unchanged values."""
from contextlib import contextmanager
from dataclasses import asdict

import pytest
from sqlalchemy import event

from database import db, engine, TaskORM, UserORM, _task_orm_to_dc
from read_context import Calculation
from test_v13_tracker import work  # noqa: F401
import tracker


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


def readers(work, superuser):
    return [work["master"], work["member"], work["outside"], superuser]


def plain_dto(task_id, uid):
    """The converter with no shared facts at all (every check evaluated directly)."""
    with db.atomic(write=True):
        with db._session() as s:
            t = s.get(TaskORM, task_id)
            original = tracker.TaskFacts.value
            tracker.TaskFacts.value = lambda self, key, load: load()
            try:
                return asdict(_task_orm_to_dc(s, t, uid))
            finally:
                tracker.TaskFacts.value = original


def test_write_unit_dto_matches_unshared_checks_and_read_unit_for_each_reader(client, work, superuser):
    task_id = work["task"]["task_id"]
    for actor in readers(work, superuser):
        with db.atomic(write=True):
            with db._session() as s:
                t = s.get(TaskORM, task_id)
                in_command = asdict(_task_orm_to_dc(s, t, actor.user_id))
        with db.atomic(write=False):
            with db._session() as s:
                in_read = asdict(_task_orm_to_dc(s, s.get(TaskORM, task_id), actor.user_id))
        assert in_command == plain_dto(task_id, actor.user_id) == in_read, actor.user_id


def test_command_dto_reads_each_fact_once(client, work):
    task_id = work["task"]["task_id"]
    uid = work["master"].user_id
    with db.atomic(write=True):
        with db._session() as s:
            t = s.get(TaskORM, task_id)
            with sql_calls() as shared:
                _task_orm_to_dc(s, t, uid)
    with db.atomic(write=True):
        with db._session() as s:
            t = s.get(TaskORM, task_id)
            original = tracker.TaskFacts.value
            tracker.TaskFacts.value = lambda self, key, load: load()
            try:
                with sql_calls() as unshared:
                    _task_orm_to_dc(s, t, uid)
            finally:
                tracker.TaskFacts.value = original
    assert len(shared) * 2 < len(unshared), (len(shared), len(unshared))


def test_legacy_assignment_answer_equals_the_full_task_entry(client, work):
    task = work["task"]
    aid = task["assignments"][0]["assignment_id"]
    member = work["member"]
    started = client.post(f"/api/assignments/{aid}/start", headers=member.headers,
                          json={"expected_revision": task["assignments"][0]["revision"]})
    assert started.status_code == 200, started.text
    full = client.get("/api/tasks/" + task["task_id"], headers=member.headers).json()
    entry = next(a for a in full["assignments"] if a["assignment_id"] == aid)
    assert started.json() == entry
    for actor in (member, work["master"]):
        with db.atomic(write=True):
            with db._session() as s:
                single = asdict(tracker.assignment_response(s, task["task_id"], aid, actor.user_id))
                whole = next(asdict(a) for a in _task_orm_to_dc(s, s.get(TaskORM, task["task_id"]), actor.user_id).assignments
                             if a.assignment_id == aid)
        assert single == whole


def test_mixed_patch_builds_one_answer_with_one_revision(client, work):
    task = work["task"]
    master = work["master"]
    calls = []
    original = tracker.enrich_task

    def counted(*args, **kwargs):
        calls.append(args[1].task_id)
        return original(*args, **kwargs)
    tracker.enrich_task = counted
    try:
        response = client.patch("/api/tasks/" + task["task_id"], headers=master.headers,
                                json={"expected_revision": task["revision"], "title": "Новое имя", "priority": "high",
                                      "file_ids": []})
    finally:
        tracker.enrich_task = original
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["title"] == "Новое имя" and saved["priority"] == "high"
    assert saved["revision"] == task["revision"] + 1
    assert calls == [task["task_id"]]
    assert saved == client.get("/api/tasks/" + task["task_id"], headers=master.headers).json()


def test_calculation_drops_values_at_any_change(make_user):
    actor = make_user(password=None)
    with db.atomic(write=True):
        with db._session() as s:
            calc = Calculation(s)
            loads = []
            assert calc.value("k", lambda: loads.append(1) or 1) == 1
            assert calc.value("k", lambda: loads.append(2) or 2) == 1
            s.get(UserORM, actor.user_id).group_number = "999"
            assert calc.value("k", lambda: loads.append(3) or 3) == 3
            s.flush()
            assert not calc.usable()
            assert Calculation(s).value("k", lambda: 4) == 4
            calc = Calculation(s)
            calc.value("k", lambda: 5)
            s.get(UserORM, actor.user_id).group_number = "888"
            s.flush()
            assert calc.value("k", lambda: 6) == 6
    assert loads == [1, 3]


def test_dirty_session_at_start_never_shares_values(make_user):
    actor = make_user(password=None)
    with db.atomic(write=True):
        with db._session() as s:
            s.get(UserORM, actor.user_id).group_number = "777"
            calc = Calculation(s)
            assert not calc.usable()
            values = iter([1, 2])
            assert calc.value("k", lambda: next(values)) == 1
            assert calc.value("k", lambda: next(values)) == 2
