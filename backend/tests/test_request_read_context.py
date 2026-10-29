"""Request-local reuse must never retain permission after a mixed workflow writes."""
import json
from contextlib import contextmanager
from dataclasses import asdict

import pytest
from sqlalchemy import delete, event, update

import access
from database import (db, engine, _user_to_ref_dc, UserORM, ContactInfoORM,
                      RoleAssignmentORM, SubeventORM)
from read_context import cached


@pytest.fixture
def scope(make_user):
    leader = make_user(password=None)
    member = make_user(password=None)
    season = db.create_season("Cache synthetic", "autumn_winter",
                              "2026-09-01T00:00:00+00:00", "2027-02-01T00:00:00+00:00")
    event_row = db.create_event(season.season_id, "Synthetic event", "")
    sub = db.create_subevent(event_row.event_id, "Synthetic team", "")
    with db._session() as s:
        s.add(RoleAssignmentORM(role_assignment_id="synthetic-lead", user_id=leader.user_id,
                               role="subevent_leader", scope_kind="subevent",
                               scope_id=sub.subevent_id, revision=1))
        s.get(SubeventORM, sub.subevent_id).organizer_user_ids_json = json.dumps([member.user_id])
        s.commit()
    return leader, member, sub


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


def projection(uid, sid):
    with db._session() as s:
        return (access.relations(uid, "subevent", sid), asdict(db.get_subevent(sid)),
                [asdict(a) for a in db.get_user_assignments(uid)],
                asdict(_user_to_ref_dc(s.get(UserORM, uid))))


def test_repeated_acl_leaders_refs_reduce_sql_with_identical_projection(scope, record_property):
    actor, _, sub = scope
    with db.atomic(write=True):
        with sql_calls() as plain:
            expected = [projection(actor.user_id, sub.subevent_id) for _ in range(6)]
    with db.atomic(write=False):
        with sql_calls() as optimized:
            actual = [projection(actor.user_id, sub.subevent_id) for _ in range(6)]
        # After the first read, neither DTOs nor central relations require more SQL.
        with sql_calls() as repeated:
            assert projection(actor.user_id, sub.subevent_id) == actual[0]
    assert actual == expected
    assert len(optimized) < len(plain) / 3, (len(plain), len(optimized))
    assert not repeated
    assert all(q.lstrip().upper().startswith("SELECT") for q in optimized)
    record_property("uncached_sql", len(plain))
    record_property("read_scope_sql", len(optimized))
    record_property("subsequent_projection_sql", len(repeated))


def test_mutable_dto_and_global_set_cannot_poison_later_reads(scope):
    actor, _, sub = scope
    with db.atomic(write=False):
        first = db.get_subevent(sub.subevent_id)
        first.title = "Caller mutation"
        first.leaders[0].user.display_name = "Caller name"
        first.leaders[0].deputy_user_ids.append(99999)
        assignments = db.get_user_assignments(actor.user_id)
        assignments.clear()
        access._global(actor.user_id).add(access.CHAIR)
        fresh = db.get_subevent(sub.subevent_id)
        assert fresh.title == "Synthetic team"
        assert fresh.leaders[0].user.display_name != "Caller name"
        assert 99999 not in fresh.leaders[0].deputy_user_ids
        assert db.get_user_assignments(actor.user_id)
        assert access.CHAIR not in access.relations(actor.user_id)


@pytest.mark.parametrize("method", ["orm", "bulk", "connection", "driver"])
def test_role_revoke_in_same_read_scope_cannot_reuse_allow(scope, method):
    actor, _, sub = scope
    with db.atomic(write=False):
        assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
        assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
        with db._session() as s:
            if method == "orm":
                s.delete(s.get(RoleAssignmentORM, "synthetic-lead"))
                s.flush()
            elif method == "bulk":
                s.execute(delete(RoleAssignmentORM).where(RoleAssignmentORM.role_assignment_id == "synthetic-lead"))
            elif method == "connection":
                s.connection().execute(delete(RoleAssignmentORM).where(RoleAssignmentORM.role_assignment_id == "synthetic-lead"))
            else:
                s.connection().exec_driver_sql("DELETE FROM role_assignments WHERE role_assignment_id=?", ("synthetic-lead",))
        assert not access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
        assert not db.get_user_assignments(actor.user_id)


def test_dirty_account_and_organizer_roster_bypass_before_and_after_flush(scope):
    _, member, sub = scope
    with db.atomic(write=False):
        assert access.allowed(member.user_id, "task.view", "subevent", sub.subevent_id)
        with db._session() as s:
            user = s.get(UserORM, member.user_id)
            user.banned = True
            assert not access.relations(member.user_id, "subevent", sub.subevent_id)
            user.banned = False
            s.get(SubeventORM, sub.subevent_id).organizer_user_ids_json = "[]"
            s.flush()
        assert not access.allowed(member.user_id, "task.view", "subevent", sub.subevent_id)
        assert db.get_subevent(sub.subevent_id).organizer_user_ids == []


@pytest.mark.parametrize("driver", [False, True])
@pytest.mark.parametrize("pending_edit", [False, True])
def test_held_account_core_revoke_refreshes_clean_attrs_without_losing_pending_edit(scope, driver, pending_edit):
    actor, _, sub = scope
    with db.atomic(write=False):
        with db._session() as s:
            held = s.get(UserORM, actor.user_id)
            assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
            if pending_edit:
                held.group_number = "Pending local change"
            if driver:
                s.connection().exec_driver_sql("UPDATE users SET banned=1 WHERE user_id=?", (actor.user_id,))
            else:
                s.connection().execute(update(UserORM).where(UserORM.user_id == actor.user_id).values(banned=True))
            assert not access.relations(actor.user_id, "subevent", sub.subevent_id)
            if pending_edit:
                assert held.group_number == "Pending local change"
                s.flush()
                assert s.get(UserORM, actor.user_id).group_number == "Pending local change"


def test_rollback_restores_role_without_stale_allow_or_deny(scope):
    actor, _, sub = scope
    with db.atomic(write=False):
        assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
        with db._session() as s:
            nested = s.begin_nested()
            s.delete(s.get(RoleAssignmentORM, "synthetic-lead"))
            s.flush()
            assert not access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
            nested.rollback()
            assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
            s.rollback()
        assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)


def test_rollback_of_new_role_restores_deny(scope):
    _, member, sub = scope
    with db.atomic(write=False):
        assert not access.allowed(member.user_id, "subevent.edit", "subevent", sub.subevent_id)
        with db._session() as s:
            nested = s.begin_nested()
            s.add(RoleAssignmentORM(role_assignment_id="new-role", user_id=member.user_id,
                                   role="subevent_leader", scope_kind="subevent",
                                   scope_id=sub.subevent_id, revision=1))
            s.flush()
            assert access.allowed(member.user_id, "subevent.edit", "subevent", sub.subevent_id)
            nested.rollback()
        assert not access.allowed(member.user_id, "subevent.edit", "subevent", sub.subevent_id)


@pytest.mark.parametrize("core", [False, True])
def test_private_grant_revoke_intersects_cached_scope_access(scope, core):
    from database import TaskQueueORM, TaskQueueMemberORM, TaskQueueRequestORM
    from task_queues import can_read
    leader, member, sub = scope
    with db._session() as s:
        s.add(TaskQueueORM(queue_id="private-cache", name="Synthetic private", key="CACHE",
                           scope_kind="subevent", scope_id=sub.subevent_id,
                           owner_user_id=leader.user_id, is_private=True))
        s.add(TaskQueueRequestORM(request_id="cache-grant", queue_id="private-cache",
                                 user_id=member.user_id, status="approved", created_at="2026-10-29T00:00:00+00:00"))
        s.add(TaskQueueMemberORM(queue_id="private-cache", user_id=member.user_id, active=True,
                                request_id="cache-grant", granted_at="2026-10-29T00:00:00+00:00",
                                granted_by_user_id=leader.user_id))
        s.commit()
    with db.atomic(write=False):
        with db._session() as s:
            queue = s.get(TaskQueueORM, "private-cache")
            assert can_read(s, queue, member.user_id)
            assert can_read(s, queue, member.user_id)
            held_grant = s.get(TaskQueueMemberORM, (queue.queue_id, member.user_id))
            if core:
                s.connection().execute(update(TaskQueueMemberORM).where(
                    TaskQueueMemberORM.queue_id == queue.queue_id,
                    TaskQueueMemberORM.user_id == member.user_id).values(active=False))
            else:
                held_grant.active = False
                s.flush()
            assert access.allowed(member.user_id, "task.view", "subevent", sub.subevent_id)
            assert not can_read(s, queue, member.user_id)


@pytest.mark.parametrize("driver", [False, True])
def test_held_organizer_roster_core_revoke(scope, driver):
    _, member, sub = scope
    with db.atomic(write=False):
        with db._session() as s:
            held = s.get(SubeventORM, sub.subevent_id)
            assert access.allowed(member.user_id, "task.view", "subevent", sub.subevent_id)
            if driver:
                s.connection().exec_driver_sql("UPDATE subevents SET organizer_user_ids_json='[]' WHERE subevent_id=?", (sub.subevent_id,))
            else:
                s.connection().execute(update(SubeventORM).where(SubeventORM.subevent_id == sub.subevent_id).values(organizer_user_ids_json="[]"))
            assert not access.allowed(member.user_id, "task.view", "subevent", sub.subevent_id)
            assert held.organizer_user_ids_json == "[]"


def test_delayed_copied_context_cannot_retain_completed_request_cache(scope):
    from contextvars import copy_context
    from read_context import cached_current, read_scope
    calls = []
    def read():
        calls.append(1)
        return len(calls)
    with db.atomic(write=False):
        with db._session() as s:
            assert cached_current("delayed", 1, read) == 1
            delayed = copy_context()
            with db.atomic(write=True):
                pass
            with read_scope(s):
                assert cached_current("delayed", 1, read) == 2
    assert delayed.run(cached_current, "delayed", 1, read) == 3
    assert delayed.run(cached_current, "delayed", 1, read) == 4


def test_lazy_read_repair_and_nested_write_never_reenable_cache(scope):
    actor, _, _ = scope
    calls = []
    def value():
        calls.append(1)
        return len(calls)
    with db.atomic(write=False):
        with db._session() as s:
            assert cached(s, "probe", 1, value) == cached(s, "probe", 1, value) == 1
            # The actual lazy metadata repair writes during a read, so no cached
            # value may survive its flush, even after the dirty collection empties.
            from directory import metadata
            metadata(s, actor.user_id)
            assert cached(s, "probe", 1, value) == 2
            assert cached(s, "probe", 1, value) == 3
    calls.clear()
    with db.atomic(write=False):
        with db._session() as s:
            assert cached(s, "probe", 1, value) == 1
            with db.atomic(write=True):
                pass
            assert cached(s, "probe", 1, value) == 2
            assert cached(s, "probe", 1, value) == 3


def test_fresh_uow_sees_committed_revoke_and_ref_changes(scope):
    actor, _, sub = scope
    with db.atomic(write=False):
        before = projection(actor.user_id, sub.subevent_id)
        assert access.SUB_LEADER in before[0]
    with db.atomic():
        with db._session() as s:
            s.execute(delete(RoleAssignmentORM).where(RoleAssignmentORM.role_assignment_id == "synthetic-lead"))
            s.get(ContactInfoORM, actor.user_id).name = "Новое имя"
    with db.atomic(write=False):
        after = projection(actor.user_id, sub.subevent_id)
        assert access.SUB_LEADER not in after[0]
        assert before[3] != after[3]
        assert "Новое имя" in after[3]["display_name"]


def test_direct_database_calls_do_not_open_implicit_cache(scope):
    actor, _, sub = scope
    with sql_calls() as first:
        assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
    with sql_calls() as second:
        assert access.allowed(actor.user_id, "subevent.edit", "subevent", sub.subevent_id)
    assert first and second


def test_actual_http_read_uow_contexts_are_isolated_and_revoke_with_same_jwt(scope):
    import asyncio
    import threading
    import httpx
    from fastapi import Depends
    from main import app
    from auth import unit_of_work, guard_working_access

    leader, member, sub = scope
    barrier = threading.Barrier(2)
    def probe():
        uid = access.actor_id.get()
        before = access.relations(uid, "subevent", sub.subevent_id)
        barrier.wait(timeout=5)
        with sql_calls() as repeated:
            after = access.relations(uid, "subevent", sub.subevent_id)
        return {"uid": uid, "before": sorted(before), "after": sorted(after), "sql": len(repeated)}

    path = "/api/__test-read-context"
    app.add_api_route(path, probe, methods=["GET"], dependencies=[Depends(unit_of_work), Depends(guard_working_access)])
    route = app.router.routes[-1]
    async def pair():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            responses = await asyncio.gather(*(client.get(path, headers=a.headers) for a in (leader, member)))
            assert all(r.status_code == 200 for r in responses)
            return [r.json() for r in responses]
    try:
        before = asyncio.run(pair())
        assert [r["uid"] for r in before] == [leader.user_id, member.user_id]
        assert all(r["before"] == r["after"] and r["sql"] == 0 for r in before)
        assert access.SUB_LEADER in before[0]["after"]
        assert access.SUB_LEADER not in before[1]["after"]
        with db.atomic():
            with db._session() as s:
                s.execute(delete(RoleAssignmentORM).where(RoleAssignmentORM.role_assignment_id == "synthetic-lead"))
        after = asyncio.run(pair())
        assert all(access.SUB_LEADER not in r["after"] for r in after)
    finally:
        app.router.routes.remove(route)
