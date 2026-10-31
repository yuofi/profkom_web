"""PB-03: readable_tasks computes one reader's account, support and global facts once.

The batch decides the same tasks as the per-task policy in a write unit of work,
with and without shared facts, for support staff, global readers, members, outsiders
and banned readers; any change drops the shared facts.
"""
from contextlib import contextmanager

from sqlalchemy import event

from database import db, engine, TaskORM, TaskTrackerORM, TaskQueueORM, UserORM
from read_context import Calculation
from task_queues import ReaderFacts, readable_tasks, task_read
from test_v13_tracker import work  # noqa: F401
from tracker import now


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


@contextmanager
def unshared():
    original = Calculation.value
    Calculation.value = lambda self, key, load: load()
    try:
        yield
    finally:
        Calculation.value = original


def _selection(work, superuser, staff):
    from support_models import SupportConfigORM, SupportStaffORM
    sid = work["task"]["season_id"]
    stamp = now()
    ids = []
    with db.atomic():
        with db._session() as s:
            s.add(TaskQueueORM(queue_id="facts-private", name="Private", key="FACTSPRIV", scope_kind="block", scope_id="IT",
                               owner_user_id=superuser.user_id, is_private=True))
            s.add(TaskQueueORM(queue_id="facts-support", name="Support", key="WEBSUPPORT", scope_kind="block", scope_id="IT",
                               owner_user_id=work["master"].user_id, is_private=True))
            s.add(SupportConfigORM(config_id=1, block_id=work["block"]["block_id"], queue_id="facts-support", revision=1))
            s.add(SupportStaffORM(user_id=staff.user_id, active=True, granted_at=stamp))
            for index, (queue_id, scope_id) in enumerate([("facts-private", "IT"), ("facts-support", "IT"), (None, "IT"),
                                                          (None, "OTHER"), (None, "THIRD")]):
                task_id = f"facts-task-{index}"
                s.add(TaskORM(task_id=task_id, season_id=sid, scope_kind="block", scope_id=scope_id, title="Синтетика",
                              assigned_at=stamp, created_by_user_id=superuser.user_id, created_at=stamp))
                if queue_id:
                    s.add(TaskTrackerORM(task_id=task_id, status="open", queue_id=queue_id, queue_number=index + 1))
                ids.append(task_id)
    return [work["task"]["task_id"]] + ids


def test_write_unit_batch_matches_per_task_policy_with_and_without_shared_facts(client, work, superuser, make_user):
    staff, banned = make_user(), make_user()
    tasks = _selection(work, superuser, staff)
    with db._session() as s:
        s.get(UserORM, banned.user_id).banned = True
        s.commit()
    readers = [work["master"], work["member"], work["outside"], staff, banned, superuser]
    seen = set()
    for reader in readers:
        uid = reader.user_id
        with db.atomic(write=True):
            with db._session() as s:
                rows = [s.get(TaskORM, task_id) for task_id in tasks]
                expected = {t.task_id for t in rows if task_read(s, t, uid)}
        with db.atomic(write=True):
            with db._session() as s:
                shared = {t.task_id for t in readable_tasks(s, [s.get(TaskORM, task_id) for task_id in tasks], uid)}
        with unshared(), db.atomic(write=True):
            with db._session() as s:
                plain = {t.task_id for t in readable_tasks(s, [s.get(TaskORM, task_id) for task_id in tasks], uid)}
        assert shared == plain == expected, uid
        seen.add(frozenset(expected))
    # The readers really differ (support gate, private queue, global reader, ban).
    assert len(seen) >= 4
    with db._session() as s:
        assert "facts-task-1" in {t.task_id for t in readable_tasks(s, [s.get(TaskORM, "facts-task-1")], staff.user_id)}


def test_shared_facts_save_queries_across_scopes(client, work, superuser, make_user):
    tasks = _selection(work, superuser, make_user())
    uid = work["member"].user_id
    with db.atomic(write=True):
        with db._session() as s:
            rows = [s.get(TaskORM, task_id) for task_id in tasks]
            with sql_calls() as shared:
                readable_tasks(s, rows, uid)
    with unshared(), db.atomic(write=True):
        with db._session() as s:
            rows = [s.get(TaskORM, task_id) for task_id in tasks]
            with sql_calls() as plain:
                readable_tasks(s, rows, uid)
    assert len(shared) < len(plain), (len(shared), len(plain))


def test_reader_facts_follow_unflushed_and_flushed_changes(client, work):
    member = work["member"].user_id
    with db.atomic(write=True):
        with db._session() as s:
            facts = ReaderFacts(s, member)
            assert facts.active() and facts.can_view_scope("block", "IT")
            s.get(UserORM, member).banned = True
            assert not facts.active()
            s.flush()
            assert not facts.active() and not facts.can_view_scope("block", "IT")
            s.get(UserORM, member).banned = False
            s.flush()
            assert facts.active() and facts.can_view_scope("block", "IT")


def test_comment_fan_out_readers_match_task_read(client, work, superuser, make_user):
    """PB-27: readers_of decides every reader of each task as task_read does."""
    from support_models import FeedbackORM
    from task_queues import readers_of
    from tracker_collaboration_models import TaskAccessGrantORM
    staff, banned, granted, revoked, reporter = (make_user() for _ in range(5))
    tasks = _selection(work, superuser, staff)
    stamp = now()
    with db._session() as s:
        s.get(UserORM, banned.user_id).banned = True
        for task_id in tasks:
            s.add(TaskAccessGrantORM(task_id=task_id, user_id=granted.user_id, source="mention", active=True, granted_at=stamp))
            s.add(TaskAccessGrantORM(task_id=task_id, user_id=revoked.user_id, source="mention", active=False,
                                     granted_at=stamp, revoked_at=stamp))
        s.add(FeedbackORM(report_id="facts-feedback", user_id=reporter.user_id, task_id="facts-task-1", kind="bug", title="T",
                          body="B", idempotency_key="facts-nonce", request_hash="facts-hash", created_at=stamp,
                          diagnostics_expires_at=stamp, state="linked"))
        s.commit()
    readers = [work["master"], work["member"], work["outside"], staff, banned, granted, revoked, reporter, superuser]
    uids = [reader.user_id for reader in readers] + [None, 987654]
    decided = set()
    for task_id in tasks:
        with db.atomic(write=True):
            with db._session() as s:
                task = s.get(TaskORM, task_id)
                expected = {uid for uid in uids if task_read(s, task, uid)}
        with db.atomic(write=True):
            with db._session() as s:
                assert readers_of(s, s.get(TaskORM, task_id), uids) == expected, task_id
        with db.atomic(write=True):
            with db._session() as s:
                s.get(UserORM, work["outside"].user_id).group_number = "dirty"  # every reader decided by task_read
                assert readers_of(s, s.get(TaskORM, task_id), uids) == expected, task_id
        decided.add(frozenset(expected))
    assert len(decided) >= 3
