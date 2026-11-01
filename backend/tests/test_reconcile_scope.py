"""PB-14/PB-12/PF-20: scoped queue-ownership rechecks and narrowed KKR reconciliation.

Queue ownership: one sequence of access changes (members, organizers, roles, bans,
the HR master and block masters as successors, material editors, a queue's own
owner) runs once with the scoped recheck and once with every queue rechecked; the
owners and recorded transfers after every step are identical, and a full recheck
afterwards never finds more to do.

KKR controls: after each narrowed change (a closed task, a title, an account
without roles, a material editor) a full reconciliation changes nothing.
"""
import json
import uuid

import pytest
from sqlalchemy import text

import kkr_control_hooks
import queue_ownership
from conftest import _truncate, user_factory
from database import (db, engine, AuditLogORM, BlockORM, LeadershipORM, RoleAssignmentORM, SeasonORM, EventORM,
                      SubeventORM, TaskQueueORM, UserORM)
from test_v13_tracker import work  # noqa: F401

STAMP = "2026-10-01T00:00:00+00:00"


def _world():
    make = user_factory()
    names = ["chair", "hr", "m1", "o1", "o2", "o3", "o4", "o5", "editor"]
    people = {name: make(password=None).user_id for name in names}
    with db._session() as s:
        s.add(LeadershipORM(id=1, chair_user_id=people["chair"], deputies_json="[]"))
        s.add(BlockORM(name="HR", master="", is_hr=True, master_user_id=people["hr"]))
        s.add(BlockORM(name="IT", master="", is_hr=False, master_user_id=people["m1"],
                       arr_of_human=json.dumps([people["o1"], people["o5"]])))
        s.add(SeasonORM(season_id="S", title="S", sequence_number=1, state="planned"))
        s.add(EventORM(event_id="E1", season_id="S", title="E1", report_series_id="ev"))
        s.add(SubeventORM(subevent_id="SUB", event_id="E1", title="SUB", report_series_id="sub",
                          organizer_user_ids_json=json.dumps([people["o2"]])))
        s.add(RoleAssignmentORM(role_assignment_id="ra-o3", user_id=people["o3"], role="event_leader",
                                scope_kind="event", scope_id="E1"))
        for queue_id, kind, scope_id, owner in [("q1", "block", "IT", "o1"), ("q2", "block", "IT", "m1"),
                                                ("q3", "subevent", "SUB", "o2"), ("q4", "event", "E1", "o3"),
                                                ("q5", "queue", "queue", "o4"), ("q6", "block", "IT", "o5")]:
            s.add(TaskQueueORM(queue_id=queue_id, name=queue_id, key=queue_id.upper(), scope_kind=kind, scope_id=scope_id,
                               owner_user_id=people[owner], is_private=False, is_default=False, next_task_number=1,
                               revision=1, created_at=STAMP))
        s.commit()
    return people


def _steps(people):
    def edit(model, key, **values):
        def run(s):
            row = s.get(model, key)
            for name, value in values.items():
                setattr(row, name, value)
        return run

    def delete_role(s):
        s.delete(s.get(RoleAssignmentORM, "ra-o3"))

    def add_editor(s):
        s.add(RoleAssignmentORM(role_assignment_id="ra-editor", user_id=people["editor"], role="material_editor",
                                scope_kind="material", scope_id="m-1"))
    return [
        # Every successor unavailable first: these queues stay with their owners.
        ("chair archived", edit(UserORM, people["chair"], account_state="archived")),
        ("hr master banned", edit(UserORM, people["hr"], banned=True)),
        ("block master banned", edit(UserORM, people["m1"], banned=True)),
        ("member leaves", edit(BlockORM, "IT", arr_of_human=json.dumps([people["o5"]]))),
        ("independent owner banned", edit(UserORM, people["o4"], banned=True)),
        # A returning successor recovers queues whose owners it does not concern.
        ("block master restored", edit(UserORM, people["m1"], banned=False)),
        ("hr master restored", edit(UserORM, people["hr"], banned=False)),
        ("organizer leaves", edit(SubeventORM, "SUB", organizer_user_ids_json="[]")),
        ("event role removed", delete_role),
        ("material editor", add_editor),
        ("queue given to a banned owner", edit(TaskQueueORM, "q6", owner_user_id=people["o4"])),
        ("chair restored", edit(UserORM, people["chair"], account_state="active")),
        ("hr master banned again", edit(UserORM, people["hr"], banned=True)),
        ("new block master", edit(BlockORM, "IT", master_user_id=people["o5"])),
    ]


def _state(s):
    owners = {q.queue_id: q.owner_user_id for q in s.query(TaskQueueORM)}
    transfers = sorted((a.target_id, a.new_values_json) for a in s.query(AuditLogORM).filter_by(target_kind="task_queue"))
    return owners, transfers


def _run(monkeypatch, scoped):
    _truncate()
    with monkeypatch.context() as patch:
        if not scoped:
            patch.setattr(queue_ownership, "_concerned", lambda session, scope: None)
        people = _world()
        states = []
        for label, step in _steps(people):
            with db.atomic():
                with db._session() as s:
                    step(s)
                    s.commit()
            with db._session() as s:
                states.append((label, _state(s)))
            # A full recheck afterwards finds nothing more to transfer.
            with db.atomic():
                with db._session() as lease:
                    assert queue_ownership.reconcile(lease.session) == 0, label
    return states


def test_scoped_queue_recheck_equals_full_recheck(monkeypatch):
    scoped = _run(monkeypatch, scoped=True)
    full = _run(monkeypatch, scoped=False)
    assert scoped == full
    # The sequence really transfers queues through every successor tier.
    tiers = {json.loads(new)["recovery_tier"] for _, (_, transfers) in scoped[-1:] for _, new in transfers}
    assert {"block_master", "hr_master", "chair"} <= tiers, tiers


def test_scope_collects_users_queues_and_full_triggers(monkeypatch):
    people = _world()
    seen = []
    original = queue_ownership.reconcile
    monkeypatch.setattr(queue_ownership, "reconcile", lambda session, scope=None: seen.append(scope) or original(session, scope))
    with db.atomic():
        with db._session() as s:
            s.get(UserORM, people["o4"]).banned = True
            s.add(RoleAssignmentORM(role_assignment_id="ra-x", user_id=people["editor"], role="material_editor",
                                    scope_kind="material", scope_id="m-1"))
            s.commit()
    assert seen[-1]["users"] == {people["o4"]} and not seen[-1]["full"]
    with db.atomic():
        with db._session() as s:
            s.get(BlockORM, "IT").is_hr = True
            s.commit()
    assert seen[-1]["full"]
    with db.atomic():
        with db._session() as s:
            s.query(UserORM).filter_by(user_id=people["o5"]).update({"banned": True}, synchronize_session=False)
            s.commit()
    assert seen[-1]["full"]
    count = len(seen)
    with db.atomic():
        with db._session() as s:
            s.get(RoleAssignmentORM, "ra-x").revision = 2  # a material editor alone: no recheck
            s.delete(s.get(RoleAssignmentORM, "ra-x"))
            s.commit()
    assert len(seen) == count


def _kkr_tables():
    with engine.connect() as connection:
        return {table: sorted(map(tuple, connection.execute(text(f"SELECT * FROM {table}"))))
                for table in ("kkr_control_epics", "task_roster", "task_links", "task_access_grants", "assignments",
                              "task_queues")} | {
            "revisions": sorted(map(tuple, connection.execute(text("SELECT task_id, revision FROM tasks"))))}


def _full_reconcile_changes_nothing():
    before = _kkr_tables()
    with db.atomic():
        with db._session() as lease:
            kkr_control_hooks.reconcile(lease.session)
    assert _kkr_tables() == before


def test_narrowed_kkr_reconciliation_leaves_nothing_to_reconcile(client, work, superuser, make_user):
    master, member = work["master"], work["member"]
    _full_reconcile_changes_nothing()
    calls = []
    original = kkr_control_hooks.reconcile
    kkr_control_hooks.reconcile = lambda session, actor_uid=None: calls.append(actor_uid) or original(session, actor_uid)
    try:
        # Closing a task links it to the block's control epic, point-wise.
        task = work["task"]
        closed = client.post(f"/api/tasks/{task['task_id']}/status", headers=master.headers,
                             json={"status": "closed", "expected_revision": task["revision"]})
        assert closed.status_code == 200, closed.text
        # A second task closed through a direct status change at commit time.
        other = client.post("/api/tasks", headers=master.headers, json={**work["payload"], "title": "Вторая"}).json()
        with db.atomic():
            with db._session() as s:
                from database import TaskTrackerORM
                s.query(TaskTrackerORM).filter_by(task_id=other["task_id"]).one().status = "closed"
                s.commit()
        assert calls == []  # both closings were linked without a full reconciliation
        assert {task["task_id"], other["task_id"]} <= _linked(work)
        _full_reconcile_changes_nothing()
        # A title, an account without roles and a material editor.
        event = client.post("/api/events", headers=superuser.headers,
                            json={"season_id": work["season"]["season_id"], "title": "Событие"})
        assert event.status_code in (200, 201), event.text
        calls.clear()
        with db.atomic():
            with db._session() as s:
                s.get(EventORM, event.json()["event_id"]).title = "Переименовано"
                plain = make_user()
                s.get(UserORM, plain.user_id).banned = True
                s.add(RoleAssignmentORM(role_assignment_id=str(uuid.uuid4()), user_id=member.user_id,
                                        role="material_editor", scope_kind="material", scope_id="m-kkr"))
                s.commit()
        assert calls == []
        # An account that does lead (the block master) still reconciles the controls.
        with db.atomic():
            with db._session() as s:
                s.get(UserORM, master.user_id).banned = True
                s.commit()
        assert calls
    finally:
        kkr_control_hooks.reconcile = original
    _full_reconcile_changes_nothing()


def _linked(work):
    from database import TaskLinkORM
    from domain_models import KkrControlEpicORM
    with db._session() as s:
        control = s.query(KkrControlEpicORM).filter_by(season_id=work["season"]["season_id"], source_kind="block").one()
        return {link.target_task_id for link in s.query(TaskLinkORM).filter_by(source_task_id=control.task_id)}


class _Rollback(Exception):
    pass


def _sync_outcome(monkeypatch, season_id, batched):
    import kkr_control
    counter = iter(range(1, 10 ** 6))
    monkeypatch.setattr(uuid, "uuid4", lambda: uuid.UUID(int=next(counter)))
    if not batched:
        original = kkr_control._Reads.__init__

        def per_scope(self, session, season):
            original(self, session, season)
            self.batched = False
        monkeypatch.setattr(kkr_control._Reads, "__init__", per_scope)
    outcome = None
    try:
        with db.atomic():
            with db._session() as lease:
                kkr_control.sync_for_season(lease.session, season_id, None)
                lease.session.flush()
                s = lease.session
                from database import TaskLinkORM, TaskRosterORM, AssignmentORM, TaskORM, TaskActivityORM
                from tracker_collaboration_models import TaskAccessGrantORM
                outcome = dict(
                    links=sorted((r.link_id, r.source_task_id, r.target_task_id) for r in s.query(TaskLinkORM)),
                    roster=sorted((r.task_id, r.user_id, r.role, r.assignment_id) for r in s.query(TaskRosterORM)),
                    assignments=sorted((r.assignment_id, r.task_id, r.assignee_user_id) for r in s.query(AssignmentORM)),
                    grants=sorted((r.task_id, r.user_id, r.active, r.source) for r in s.query(TaskAccessGrantORM)),
                    revisions=sorted((r.task_id, r.revision) for r in s.query(TaskORM)),
                    activity=sorted((r.event_id, r.task_id, r.kind) for r in s.query(TaskActivityORM)))
                raise _Rollback
    except _Rollback:
        pass
    monkeypatch.undo()
    return outcome


def test_batched_season_sync_equals_per_scope_sync(client, work, superuser, make_user, monkeypatch):
    sid = work["season"]["season_id"]
    leader, sub_leader, deputy = make_user(), make_user(), make_user()
    event = client.post("/api/events", headers=superuser.headers, json={"season_id": sid, "title": "Событие"}).json()
    tasks = [client.post("/api/tasks", headers=work["master"].headers,
                         json={**work["payload"], "title": f"Задача {i}"}).json()["task_id"] for i in range(3)]
    linked = client.get("/api/tasks/" + tasks[2], headers=work["master"].headers).json()
    assert client.post(f"/api/tasks/{tasks[2]}/status", headers=work["master"].headers,
                       json={"status": "closed", "expected_revision": linked["revision"]}).status_code == 200
    # Drift the hooks never saw (driver-level SQL): closed tasks, a lost roster row,
    # new leaders and an HR deputy, for the full sync to repair.
    with engine.begin() as connection:
        connection.execute(text("UPDATE task_tracker SET status='closed' WHERE task_id IN (:a, :b)"),
                           dict(a=tasks[0], b=tasks[1]))
        connection.execute(text("DELETE FROM task_roster WHERE task_id IN (SELECT task_id FROM kkr_control_epics) "
                                "AND role='assignee'"))
        connection.execute(text("INSERT INTO role_assignments (role_assignment_id, user_id, role, scope_kind, scope_id, revision) "
                                "VALUES ('drift-1', :u, 'event_leader', 'event', :e, 1)"), dict(u=leader.user_id, e=event["event_id"]))
        connection.execute(text("UPDATE block SET is_hr=1 WHERE name='IT'"))
        connection.execute(text("INSERT INTO role_assignments (role_assignment_id, user_id, role, scope_kind, scope_id, revision) "
                                "VALUES ('drift-2', :u, 'deputy_master', 'block', 'IT', 1)"), dict(u=deputy.user_id))
    batched = _sync_outcome(monkeypatch, sid, batched=True)
    per_scope = _sync_outcome(monkeypatch, sid, batched=False)
    assert batched == per_scope
    assert {tasks[0], tasks[1]} <= {target for _, _, target in batched["links"]}
    assert any(user == deputy.user_id for _, user, _, _ in batched["roster"])
