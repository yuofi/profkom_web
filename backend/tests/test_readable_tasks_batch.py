"""PB-18/PB-07: batched task readability in a read UOW equals the per-task policy.

The same selection (public, private, default and KKR-control tasks; mention, revoked
and control grants; banned, outside and queue-member readers) is decided per task
without a read UOW and then by readable_tasks / readable_tasks_many inside one.
"""
from sqlalchemy import event

from database import db, engine, TaskORM, UserORM
from domain_models import KkrControlEpicORM
from task_queues import readable_tasks, readable_tasks_many, task_read
from test_tracker_queues import make_queue, request_grant, create_in
from test_v13_tracker import work  # noqa: F401
from tracker import now
from tracker_collaboration_models import TaskAccessGrantORM


def _grant(s, task_id, uid, source="mention", active=True):
    row = s.get(TaskAccessGrantORM, (task_id, uid)) or TaskAccessGrantORM(task_id=task_id, user_id=uid)
    row.active, row.source, row.granted_at, row.revoked_at = active, source, now(), None if active else now()
    s.add(row)


def test_batched_task_readability_matches_per_task_policy(client, work, superuser, make_user):
    w = work
    public = make_queue(client, w, key="OPEN")
    private = make_queue(client, w, key="HIDE", private=True)
    request_grant(client, private, w["member"], w["master"])
    tasks = [w["task"]["task_id"]]
    tasks += [create_in(client, w, public, title="Открытая")["task_id"]]
    tasks += [create_in(client, w, private, title=f"Закрытая {i}")["task_id"] for i in range(3)]
    banned = make_user()
    peer = make_user()
    with db._session() as s:
        # The season's KKR control task of this block (created when it opened).
        tasks.append(s.query(KkrControlEpicORM.task_id).filter_by(season_id=w["season"]["season_id"]).first()[0])
        _grant(s, tasks[2], w["outside"].user_id)
        _grant(s, tasks[3], w["outside"].user_id, active=False)
        _grant(s, tasks[5], w["outside"].user_id, source="control")
        _grant(s, tasks[5], peer.user_id)
        _grant(s, tasks[5], w["master"].user_id, source="control")
        _grant(s, tasks[2], banned.user_id)
        s.get(UserORM, banned.user_id).banned = True
        s.commit()
    users = [w["master"].user_id, w["member"].user_id, w["outside"].user_id, banned.user_id, peer.user_id,
             superuser.user_id, 0]

    def rows(s):
        return [s.get(TaskORM, task_id) for task_id in tasks] + [None]

    expected = {}
    for uid in users:
        with db._session() as s:
            expected[uid] = {t.task_id for t in rows(s) if t is not None and task_read(s, t, uid)}
        with db._session() as s:
            assert {t.task_id for t in readable_tasks(s, rows(s), uid)} == expected[uid], uid
    assert expected[w["outside"].user_id] & set(tasks[2:]) == {tasks[2]}
    assert tasks[5] not in expected[w["outside"].user_id] | expected[peer.user_id] and not expected[banned.user_id]

    statements = []
    def count(*_args):
        statements.append(1)
    with db.atomic(write=False):
        with db._session() as s:
            event.listen(engine, "before_cursor_execute", count)
            try:
                many = readable_tasks_many(s, {uid: rows(s) for uid in users})
                # The hints recorded above are the decisions task_read now returns.
                hinted = {uid: {t.task_id for t in rows(s) if t is not None and task_read(s, t, uid)} for uid in users}
                batched = {uid: {t.task_id for t in readable_tasks(s, rows(s), uid)} for uid in users}
            finally:
                event.remove(engine, "before_cursor_execute", count)
    assert many == {uid: expected[uid] for uid in users if uid}
    assert hinted == expected and batched == expected
    assert statements

    # Outside a read UOW the multi-user batch records nothing and changes nothing.
    with db._session() as s:
        assert readable_tasks_many(s, {uid: rows(s) for uid in users}) == {}
