"""Batch DTO hydration keeps the uncached contract and current command semantics."""
from contextlib import contextmanager
from types import SimpleNamespace
import json

import pytest
from sqlalchemy import event, insert, delete

import main
from database import (db, engine, TaskORM, TaskTrackerORM, AssignmentORM, SubmissionORM,
    TaskSubmissionORM, TaskChecklistORM, TaskLinkORM, TaskFavoriteORM, TaskRosterORM,
    FileRecordORM, TaskQueueORM)
from read_context import orm_rows, prime_rows
from task_reads import TaskIndex
from tracker import _rows
from task_queues import can_read, task_read
from support import is_support_queue, owns_task
from support_models import SupportConfigORM, FeedbackORM
from test_task_read_projections import task_set  # noqa: F401
from test_v13_tracker import work  # noqa: F401


@contextmanager
def sql_calls():
    statements = []
    def count(_conn, _cursor, statement, _parameters, _context, _many):
        statements.append(statement)
    event.listen(engine, 'before_cursor_execute', count)
    try:
        yield statements
    finally:
        event.remove(engine, 'before_cursor_execute', count)


def wire(task):
    return main._to_task_public_out(task).model_dump(mode='json')


def test_selected_aggregate_matches_uncached_full_contract_and_repeat_has_no_sql(task_set):
    uid = task_set['master'].user_id
    tid = task_set['task']['task_id']
    stamp = '2026-10-20T12:00:00+00:00'
    with db.atomic():
        with db._session() as session:
            aid = session.query(AssignmentORM).filter_by(task_id=tid).one().assignment_id
            for fid, state in [('aggregate-file', 'completed'), ('aggregate-pending', 'pending')]:
                session.add(FileRecordORM(file_id=fid, owner_kind='task', owner_id=tid, purpose='task_result',
                    name=fid+'.txt', mime_type='text/plain', size_bytes=8, uploaded_by_user_id=uid,
                    state=state, created_at=stamp, expires_at=stamp))
            session.add(SubmissionORM(submission_id='aggregate-legacy', assignment_id=aid, submitted_at=stamp,
                text_json=json.dumps({'format':'markdown','body':'Legacy result'}), links_json='[]',
                files_json=json.dumps(['aggregate-file','aggregate-pending','aggregate-missing']), created_by_user_id=uid))
            session.add(TaskSubmissionORM(submission_id='aggregate-shared', task_id='projection-task-00',
                submitted_at=stamp, created_by_user_id=uid,
                text_json=json.dumps({'format':'markdown','body':'Shared result'}), links_json='[]',
                files_json=json.dumps(['aggregate-file','aggregate-pending','aggregate-missing'])))
            session.query(TaskTrackerORM).filter_by(task_id=tid).one().files_json = '["aggregate-file","aggregate-pending","aggregate-missing"]'
            session.query(TaskTrackerORM).filter_by(task_id='projection-task-00').one().parent_task_id = tid
            session.add(TaskChecklistORM(item_id='aggregate-check', task_id=tid, text='Read', checked=True, position=0))
            session.add(TaskLinkORM(link_id='aggregate-link', source_task_id=tid, target_task_id='projection-task-01',
                kind='related', created_by_user_id=uid, created_at=stamp))
            session.add(TaskFavoriteORM(task_id=tid, user_id=uid))
            session.add(TaskRosterORM(task_id=tid, user_id=uid, role='watcher'))
            session.add(TaskRosterORM(task_id=tid, user_id=task_set['outside'].user_id, role='watcher'))
    with db.atomic(write=True):
        expected = {item.task_id:wire(item) for item in db.list_tasks(current_user_id=uid)}
    with db.atomic(write=False):
        with db._session() as session:
            index = TaskIndex(session, uid)
            entries = index.readable()
            with sql_calls() as first_sql:
                index.prepare(entries)
                actual = {item.task_id:wire(index.project(item)) for item in entries}
            assert actual == expected
            assert len(first_sql) < 160, len(first_sql)
            assert all(statement.lstrip().upper().startswith('SELECT') for statement in first_sql)
            # A multi-row composite-PK roster keeps its original single-task SQL
            # order; the global index order is only an ACL/selection fact.
            assert sum('FROM task_roster' in statement and 'WHERE task_roster.task_id = ?' in statement for statement in first_sql) == 1
            with sql_calls() as repeat_sql:
                repeated = {item.task_id:wire(index.project(item)) for item in entries}
            assert repeated == expected and repeat_sql == []
            assert [item['file_id'] for item in actual[tid]['attachments']] == ['aggregate-file']
            assert len(actual[tid]['assignments'][0]['submissions'][0]['files']) == 3
            assert len(actual['projection-task-00']['submissions'][0]['files']) == 1
            index.project(entries[0]).capabilities.clear()
            assert wire(index.project(entries[0])) == expected[entries[0].task_id]


@pytest.mark.parametrize('mode', ['orm', 'core', 'driver'])
def test_negative_relation_cache_disables_after_insert_and_delete(work, mode):
    tid = work['task']['task_id']
    with db.atomic(write=False):
        with db._session() as session:
            assert _rows(session, TaskChecklistORM, task_id=tid) == []
            with sql_calls() as repeated:
                assert _rows(session, TaskChecklistORM, task_id=tid) == []
            assert not repeated
            values = dict(item_id='fresh-cache-check', task_id=tid, text='New', checked=False, position=0)
            if mode == 'orm':
                session.add(TaskChecklistORM(**values))
                assert _rows(session, TaskChecklistORM, task_id=tid)[0].text == 'New'
                session.flush()
            elif mode == 'core':
                session.connection().execute(insert(TaskChecklistORM).values(**values))
            else:
                session.connection().exec_driver_sql('INSERT INTO task_checklist(item_id,task_id,text,checked,position) VALUES (?,?,?,?,?)',
                    ('fresh-cache-check', tid, 'New', False, 0))
            rows = _rows(session, TaskChecklistORM, task_id=tid)
            assert [row.item_id for row in rows] == ['fresh-cache-check']
            if mode == 'orm':
                session.delete(rows[0]);session.flush()
            elif mode == 'core':
                session.connection().execute(delete(TaskChecklistORM).where(TaskChecklistORM.item_id == 'fresh-cache-check'))
            else:
                session.connection().exec_driver_sql('DELETE FROM task_checklist WHERE item_id=?', ('fresh-cache-check',))
            assert _rows(session, TaskChecklistORM, task_id=tid) == []


@pytest.mark.parametrize('mode', ['orm', 'core', 'driver'])
def test_negative_support_config_then_insert_revokes_cached_normal_queue_access(work, mode):
    uid = work['member'].user_id
    with db.atomic(write=False):
        with db._session() as session:
            task = session.get(TaskORM, work['task']['task_id'])
            meta = session.query(TaskTrackerORM).filter_by(task_id=task.task_id).one()
            queue = session.get(TaskQueueORM, meta.queue_id)
            assert not is_support_queue(session, queue)
            assert task_read(session, task, uid)
            values = dict(config_id=1, queue_id=queue.queue_id, revision=1)
            if mode == 'orm':
                session.add(SupportConfigORM(**values));session.flush()
            elif mode == 'core':
                session.connection().execute(insert(SupportConfigORM).values(**values))
            else:
                session.connection().exec_driver_sql('INSERT INTO support_config(config_id,queue_id,revision) VALUES (?,?,?)', (1, queue.queue_id, 1))
            assert is_support_queue(session, queue)
            assert not can_read(session, queue, uid)
            assert not task_read(session, task, uid)


def test_acl_memo_keys_include_in_memory_scope_and_private_queue_policy(work):
    uid = work['member'].user_id
    with db.atomic(write=False):
        with db._session() as session:
            assert not task_read(session, SimpleNamespace(task_id='same-legacy-id', scope_kind='queue', scope_id='missing'), uid)
            assert task_read(session, SimpleNamespace(task_id='same-legacy-id', scope_kind='block', scope_id='IT'), uid)
            shared = dict(queue_id='in-memory-policy', scope_kind='queue', scope_id='independent', owner_user_id=work['master'].user_id)
            assert can_read(session, SimpleNamespace(**shared, is_private=False), uid)
            assert not can_read(session, SimpleNamespace(**shared, is_private=True), uid)


def test_ownership_query_does_not_materialize_private_diagnostics_and_sees_new_report(work):
    uid, tid = work['member'].user_id, work['task']['task_id']
    with db.atomic(write=False):
        with db._session() as session:
            with sql_calls() as statements:
                assert not owns_task(session, tid, uid)
            assert any('feedback_reports.report_id' in item for item in statements)
            assert all('diagnostics_json' not in item and 'screenshot' not in item for item in statements)
            session.add(FeedbackORM(report_id='ownership-proof', user_id=uid, task_id=tid, kind='bug', title='Synthetic', body='Synthetic',
                diagnostics_json='{}', screenshot='synthetic-private-marker', idempotency_key='ownership-proof', request_hash='0'*64,
                created_at='2026-10-20T12:00:00+00:00', diagnostics_expires_at='2027-01-18T12:00:00+00:00', state='linked'))
            session.flush()
            assert owns_task(session, tid, uid)


def test_relation_identity_cache_fresh_lists_and_rollback_are_not_stale(work):
    tid = work['task']['task_id']
    with db.atomic(write=False):
        with db._session() as session:
            load = lambda: session.query(AssignmentORM).filter_by(task_id=tid).all()
            first = orm_rows(session, 'test.assignment', tid, load)
            saved = first[0].assignment_id
            first.clear()
            assert orm_rows(session, 'test.assignment', tid, load)[0].assignment_id == saved
            nested = session.begin_nested()
            session.delete(session.get(AssignmentORM, saved));session.flush()
            assert orm_rows(session, 'test.assignment', tid, load) == []
            nested.rollback()
            assert orm_rows(session, 'test.assignment', tid, load)[0].assignment_id == saved
    with db.atomic(write=False):
        with db._session() as session:
            with sql_calls() as new_request:
                orm_rows(session, 'test.assignment', tid, lambda:session.query(AssignmentORM).filter_by(task_id=tid).all())
            assert new_request
            detached = AssignmentORM(assignment_id='pending', task_id=tid, assignee_user_id=work['member'].user_id)
            assert not prime_rows(session, 'test.assignment', 'pending', [detached])


def test_joint_legacy_timestamp_ties_keep_original_task_local_fallback_query(task_set):
    """A page-wide IN may choose another SQLite plan/order for equal timestamps."""
    uid, tid = task_set['master'].user_id, task_set['task']['task_id']
    stamp = '2026-10-20T12:00:00+00:00'
    with db.atomic():
        with db._session() as session:
            session.info['tracker_batch'] = True
            base = session.query(AssignmentORM).filter_by(task_id=tid).one()
            aid = base.assignment_id
            values = {column.name:getattr(base,column.name) for column in AssignmentORM.__table__.columns}
            values.update(assignment_id='zz-joint-assignment', assignee_user_id=task_set['outside'].user_id)
            session.add(AssignmentORM(**values))
            session.add(TaskRosterORM(task_id=tid, user_id=task_set['outside'].user_id,
                role='assignee', assignment_id='zz-joint-assignment'))
            # Physical insertion and assignment-index ordering intentionally differ.
            for sid, target in [('z-inserted-first','zz-joint-assignment'), ('a-inserted-second',aid)]:
                session.add(SubmissionORM(submission_id=sid, assignment_id=target, submitted_at=stamp,
                    text_json='{"format":"markdown","body":"Tied"}', links_json='[]', files_json='[]', created_by_user_id=uid))
    with db.atomic(write=True):
        expected = wire(db.get_task(tid, uid))
    with db.atomic(write=False):
        with db._session() as session:
            index = TaskIndex(session, uid)
            entries = index.readable()
            index.prepare(entries)
            with sql_calls() as statements:
                actual = wire(index.project(next(entry for entry in entries if entry.task_id == tid)))
            assert actual == expected
            fallback = [statement for statement in statements if 'submissions.assignment_id IN (?, ?)' in statement]
            assert len(fallback) == 1 and 'ORDER BY submissions.submitted_at' in fallback[0]


@pytest.mark.parametrize('mode', ['orm', 'core', 'driver'])
def test_scalar_block_mapping_memo_sees_rename_in_same_and_next_uow(work, mode):
    from sqlalchemy import update
    from domain_models import BlockMetaORM
    from membership import block_id_for, legacy_name
    bid = work['block']['block_id']
    with db.atomic(write=False):
        assert legacy_name(bid) == 'IT' and block_id_for('IT') == bid
        with sql_calls() as repeated:
            assert legacy_name(bid) == 'IT' and block_id_for('IT') == bid
        assert repeated == []
        with db._session() as session:
            # Direct persistence mutations deliberately test cache invalidation,
            # independently of the already-covered atomic domain rename command.
            if mode == 'orm':
                session.get(BlockMetaORM, bid).legacy_name = 'Renamed synthetic'
                assert legacy_name(bid) == 'Renamed synthetic'
                session.flush()
            elif mode == 'core':
                session.connection().execute(update(BlockMetaORM).where(BlockMetaORM.block_id == bid).values(legacy_name='Renamed synthetic'))
            else:
                session.connection().exec_driver_sql('UPDATE block_metadata SET legacy_name=? WHERE block_id=?', ('Renamed synthetic',bid))
        assert legacy_name(bid) == 'Renamed synthetic'
        assert block_id_for('Renamed synthetic') == bid
    with db.atomic(write=False):
        assert legacy_name(bid) == 'Renamed synthetic'
        assert block_id_for('Renamed synthetic') == bid


def test_missing_block_mapping_read_repair_never_reenables_read_cache(work):
    from database import BlockORM
    from membership import block_id_for, legacy_name
    from read_context import cached
    with db.atomic():
        with db._session() as session:
            session.add(BlockORM(name='Unmapped synthetic', master='', arr_of_human='[]'))
    calls = []
    def probe():
        calls.append(1)
        return len(calls)
    with db.atomic(write=False):
        with db._session() as session:
            assert cached(session,'mapping-probe',1,probe) == cached(session,'mapping-probe',1,probe) == 1
            bid = block_id_for('Unmapped synthetic')
            assert legacy_name(bid) == 'Unmapped synthetic'
            assert cached(session,'mapping-probe',1,probe) == 2
            assert cached(session,'mapping-probe',1,probe) == 3
    with db.atomic(write=False):
        assert block_id_for('Unmapped synthetic') == bid
        assert legacy_name(bid) == 'Unmapped synthetic'


def test_batch_acl_seed_keeps_same_id_different_fallback_scope_separate(work):
    from task_queues import readable_tasks
    uid = work['member'].user_id
    blocked = SimpleNamespace(task_id='same-batch-legacy', scope_kind='queue', scope_id='missing')
    allowed = SimpleNamespace(task_id='same-batch-legacy', scope_kind='block', scope_id='IT')
    with db.atomic(write=False):
        with db._session() as session:
            assert readable_tasks(session,[blocked,allowed],uid) == [allowed]
            assert not task_read(session,blocked,uid)
            assert task_read(session,allowed,uid)


def test_optional_prefetch_keeps_malformed_legacy_file_json_tolerance_with_shared_result(work):
    uid, tid = work['master'].user_id, work['task']['task_id']
    stamp = '2026-10-20T12:00:00+00:00'
    with db.atomic():
        with db._session() as session:
            aid = session.query(AssignmentORM).filter_by(task_id=tid).one().assignment_id
            session.add(SubmissionORM(submission_id='malformed-legacy-file-list', assignment_id=aid,
                submitted_at=stamp, text_json='{"format":"markdown","body":"Old result"}',
                links_json='[]', files_json='not-json', created_by_user_id=uid))
            session.add(TaskSubmissionORM(submission_id='valid-shared-result', task_id=tid, submitted_at=stamp,
                text_json='{"format":"markdown","body":"Current result"}', links_json='[]', files_json='[]', created_by_user_id=uid))
    with db.atomic(write=True):
        expected = wire(db.get_task(tid, uid))
    with db.atomic(write=False):
        with db._session() as session:
            index = TaskIndex(session, uid)
            entries = index.readable()
            index.prepare(entries)
            actual = wire(index.project(entries[0]))
    assert actual == expected
    assert actual['assignments'][0]['submissions'][0]['files'] == []
    assert actual['submissions'][0]['submission_id'] == 'valid-shared-result'


def test_unhashable_orm_identity_keeps_session_get_lookup_and_failure_semantics(work):
    from read_context import orm_get
    from sqlalchemy.exc import InvalidRequestError
    tid = work['task']['task_id']
    with db.atomic(write=False):
        with db._session() as session:
            for identity in ([tid], {'task_id':tid}):
                assert orm_get(session, TaskORM, identity) is session.get(TaskORM, identity)
                assert orm_get(session, TaskORM, identity).task_id == tid
            for identity in ([tid, 'extra'], {'wrong_pk_name':tid}):
                with pytest.raises(InvalidRequestError):
                    session.get(TaskORM, identity)
                with pytest.raises(InvalidRequestError):
                    orm_get(session, TaskORM, identity)
