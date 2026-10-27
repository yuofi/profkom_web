"""Recover unavailable queue ownership in the transaction that changes its access.

The fallback is an actual block master (only for a block queue), then an actual
HR master, then the current chair. It grants no membership, role or accounting
rights. Read requests never reconcile; a startup pass repairs older orphan rows.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import sys

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

from database import (
    AuditLogORM, BlockORM, LeadershipORM, RoleAssignmentORM, SubeventORM,
    TaskQueueORM, UserORM, _active_session, db,
)

_MARKER = "queue_owner_recovery_needed"
_RUNNING = "queue_owner_recovery_running"
_STARTUP_PENDING = False
_RELEVANT = {
    UserORM: ("account_state", "banned", "blocks"),
    BlockORM: ("name", "master_user_id", "is_hr", "arr_of_human"),
    LeadershipORM: ("chair_user_id", "deputies_json"),
    RoleAssignmentORM: ("user_id", "role", "scope_kind", "scope_id", "principal_assignment_id"),
    SubeventORM: ("organizer_user_ids_json", "event_id"),
    TaskQueueORM: ("owner_user_id", "scope_kind", "scope_id"),
}


@contextmanager
def _same_session(session):
    """ACL helpers must observe the just-flushed transaction, including scripts."""
    current = _active_session.get()
    if current is not None and current is not session:
        raise RuntimeError("Queue recovery requires its owning transaction")
    token = _active_session.set(session) if current is None else None
    try:
        yield
    finally:
        if token is not None:
            _active_session.reset(token)


def owner_available(session, queue, user_id=None):
    """The prospective owner needs active account + underlying scope read.

    Private-queue grants are unnecessary: ownership itself grants private read,
    while it can never bypass the underlying block/subevent ACL.
    """
    from task_queues import active, base_read
    from access import all_queue_reader

    uid = queue.owner_user_id if user_id is None else user_id
    return bool(uid and active(session, uid) and (all_queue_reader(uid) or base_read(uid, queue)))


def _successor(session, queue):
    candidates = []
    if queue.scope_kind == "block":
        block = session.get(BlockORM, queue.scope_id)
        if block and block.master_user_id:
            candidates.append((block.master_user_id, "block_master"))
    # is_hr is the configured identity; no matching by title, name or legacy flags.
    for block in session.query(BlockORM).filter_by(is_hr=True).order_by(BlockORM.name):
        if block.master_user_id:
            candidates.append((block.master_user_id, "hr_master"))
    leadership = session.get(LeadershipORM, 1)
    if leadership and leadership.chair_user_id:
        candidates.append((leadership.chair_user_id, "chair"))
    seen = set()
    for uid, tier in candidates:
        if uid not in seen and owner_available(session, queue, uid):
            return uid, tier
        seen.add(uid)
    return None


def _record_transfer(session, queue, previous, successor, tier):
    from access import actor_id

    session.add(AuditLogORM(
        target_kind="task_queue", target_id=queue.queue_id,
        changed_by_user_id=actor_id.get() or session.info.get("tracker_actor") or 0,
        reason="Automatic queue ownership recovery",
        old_values_json=json.dumps({"owner_user_id": previous}),
        new_values_json=json.dumps({"owner_user_id": successor, "recovery_tier": tier,
                                    "automatic": True, "queue_revision": queue.revision}),
        created_at=datetime.now(timezone.utc).isoformat(),
    ))


def reconcile(session):
    """Return transfer count; caller owns commit/rollback and any write lock."""
    if session.info.get(_RUNNING):
        return 0
    session.info[_RUNNING] = True
    changed = 0
    try:
        with _same_session(session):
            session.flush()
            session.expire_all()  # include ORM bulk commands using synchronize_session=False
            for queue in session.query(TaskQueueORM).order_by(TaskQueueORM.queue_id):
                if owner_available(session, queue):
                    continue
                successor = _successor(session, queue)
                if successor is None:
                    # Keep the unavailable historic owner, not an arbitrary deputy.
                    # A later real leader change can recover this same queue.
                    continue
                uid, tier = successor
                previous = queue.owner_user_id
                queue.owner_user_id = uid
                queue.revision = (queue.revision or 1) + 1
                _record_transfer(session, queue, previous, uid, tier)
                changed += 1
            session.flush()
        return changed
    finally:
        session.info.pop(_RUNNING, None)
        session.info.pop(_MARKER, None)


def reconcile_existing():
    """One idempotent startup repair, after all normal schema/data migrations."""
    global _STARTUP_PENDING
    policy = sys.modules.get("access")
    if policy is not None and not getattr(policy, "_QUEUE_OWNER_RECOVERY_READY", False):
        # main imports access before database. In that order the ACL module is
        # still paused at its database import; its own tail completes this repair.
        # Database-first scripts instead import the complete policy on first use.
        _STARTUP_PENDING = True
        return 0
    with db.atomic():
        with db._session() as lease:
            session = getattr(lease, "session", lease)
            changed = reconcile(session)
    _STARTUP_PENDING = False
    return changed


def startup_recovery_pending():
    return _STARTUP_PENDING


def finish_startup_recovery():
    """Called only after the access module has defined its full policy API."""
    return reconcile_existing() if _STARTUP_PENDING else 0


def install_hooks():
    if getattr(install_hooks, "installed", False):
        return
    install_hooks.installed = True

    @event.listens_for(Session, "before_flush")
    def track_access_changes(session, _context, _instances):
        if session.info.get(_RUNNING):
            return
        relevant = tuple(_RELEVANT)
        if any(isinstance(obj, relevant) for obj in (*session.new, *session.deleted)):
            session.info[_MARKER] = True
            return
        for obj in session.dirty:
            fields = _RELEVANT.get(type(obj))
            if fields and any(inspect(obj).attrs[field].history.has_changes() for field in fields):
                session.info[_MARKER] = True
                return

    @event.listens_for(Session, "do_orm_execute")
    def track_bulk_access_changes(state):
        if state.session.info.get(_RUNNING) or not (state.is_update or state.is_delete):
            return
        table = getattr(state.statement, "table", None)
        if table is not None and table.name in {model.__tablename__ for model in _RELEVANT}:
            state.session.info[_MARKER] = True

    @event.listens_for(Session, "before_commit")
    def recover_after_final_command_state(session):
        if session.info.get(_RUNNING):
            return
        # Nested _SessionLease.commit() only flushes. This runs at the real outer
        # commit, after archive has removed all roles and marked the account inactive.
        session.flush()
        if session.info.get(_MARKER):
            reconcile(session)

    @event.listens_for(Session, "after_rollback")
    @event.listens_for(Session, "after_commit")
    def clear_marker(session):
        session.info.pop(_MARKER, None)
