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
from domain_models import BlockMetaORM
from event_workspace_models import EventWorkspaceMetaORM

_MARKER = "queue_owner_recovery_needed"
_RUNNING = "queue_owner_recovery_running"
# What the command changed: the users whose access may differ, the queues and the
# scopes concerned; "full" when the change can move anyone's access.
_SCOPE = "queue_owner_recovery_scope"
_STARTUP_PENDING = False
_RELEVANT = {
    UserORM: ("account_state", "banned", "blocks"),
    BlockORM: ("name", "master_user_id", "is_hr", "arr_of_human"),
    BlockMetaORM: ("hr_user_id", "archived_at"),
    EventWorkspaceMetaORM: ("hr_user_id",),
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
    while it can never bypass the underlying block/subevent ACL. The service account
    is never an owner: a queue it holds passes to the next owner.
    """
    from task_queues import active, base_read
    from access import all_queue_reader
    from service_account import refused

    uid = queue.owner_user_id if user_id is None else user_id
    return bool(uid and active(session, uid) and not refused(session, uid)
                and (all_queue_reader(uid) or base_read(uid, queue)))


def _successor(session, queue):
    candidates = []
    if queue.scope_kind == "block":
        block = session.get(BlockORM, queue.scope_id)
        if block and block.master_user_id:
            candidates.append((block.master_user_id, "block_master"))
    # is_hr is the configured identity; no matching by title, name or legacy flags.
    from block_lifecycle import archived_identities
    archived = archived_identities(session)
    for block in session.query(BlockORM).filter_by(is_hr=True).order_by(BlockORM.name):
        if block.master_user_id and block.name not in archived:
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


def _concerned(session, scope):
    """Which queues a scoped recheck visits, or None for all of them.

    A queue's decision depends only on its owner's access and, when the owner is
    unavailable, on its successor candidates (its block's master, HR masters, the
    chair). So the queues owned by affected users, the changed queues, the queues of
    changed scopes and of blocks an affected user masters are rechecked; an affected
    HR master or chair (a candidate for every queue) rechecks all.
    """
    if scope is None or scope["full"]:
        return None
    users = {uid for uid in scope["users"] if uid is not None}
    leadership = session.get(LeadershipORM, 1)
    candidates = {leadership.chair_user_id} if leadership else set()
    candidates |= {block.master_user_id for block in session.query(BlockORM).filter_by(is_hr=True)}
    if users & candidates:
        return None
    scopes = set(scope["scopes"])
    if users:
        scopes |= {("block", name) for name, in session.query(BlockORM.name).filter(BlockORM.master_user_id.in_(sorted(users)))}
    return users, set(scope["queues"]), scopes


def reconcile(session, scope=None):
    """Return transfer count; caller owns commit/rollback and any write lock.

    ``scope`` (collected by the flush hooks) limits the recheck to the queues a
    command can have affected; None rechecks every queue.
    """
    if session.info.get(_RUNNING):
        return 0
    session.info[_RUNNING] = True
    changed = 0
    try:
        with _same_session(session):
            session.flush()
            session.expire_all()  # include ORM bulk commands using synchronize_session=False
            concerned = _concerned(session, scope)
            for queue in session.query(TaskQueueORM).order_by(TaskQueueORM.queue_id):
                if concerned is not None and not (queue.owner_user_id in concerned[0] or queue.queue_id in concerned[1]
                                                  or (queue.scope_kind, queue.scope_id) in concerned[2]):
                    continue
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
        session.info.pop(_SCOPE, None)


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
        for obj in (*session.new, *session.deleted):
            if isinstance(obj, relevant) and not _material_role(obj):
                session.info[_MARKER] = True
                _note(session, obj, "deleted" if obj in session.deleted else "new")
        for obj in session.dirty:
            fields = _RELEVANT.get(type(obj))
            if fields and any(inspect(obj).attrs[field].history.has_changes() for field in fields) and not _material_role(obj):
                session.info[_MARKER] = True
                _note(session, obj, "dirty")

    @event.listens_for(Session, "do_orm_execute")
    def track_bulk_access_changes(state):
        if state.session.info.get(_RUNNING) or not (state.is_update or state.is_delete):
            return
        table = getattr(state.statement, "table", None)
        if table is not None and table.name in {model.__tablename__ for model in _RELEVANT}:
            state.session.info[_MARKER] = True
            _scope(state.session)["full"] = True  # a bulk command names no rows

    @event.listens_for(Session, "before_commit")
    def recover_after_final_command_state(session):
        if session.info.get(_RUNNING):
            return
        # Nested _SessionLease.commit() only flushes. This runs at the real outer
        # commit, after archive has removed all roles and marked the account inactive.
        session.flush()
        if session.info.get(_MARKER):
            reconcile(session, session.info.get(_SCOPE))

    @event.listens_for(Session, "after_rollback")
    @event.listens_for(Session, "after_commit")
    def clear_marker(session):
        session.info.pop(_MARKER, None)
        session.info.pop(_SCOPE, None)


def _scope(session):
    return session.info.setdefault(_SCOPE, dict(users=set(), queues=set(), scopes=set(), full=False))


def _values(obj, name):
    """Every value of an attribute in this flush: before and after the change."""
    history = inspect(obj).attrs[name].history
    return [*history.deleted, *history.added, *history.unchanged]


def _listed(raw):
    try:
        values = json.loads(raw) if raw else []
    except Exception:
        return set()
    return set(values) if isinstance(values, list) else set()


def _changed(obj, name):
    return inspect(obj).attrs[name].history.has_changes()


def _material_role(obj):
    """A material editor or a site grant (bot maintainer, broadcast sender), before and after
    the change, reads no queue or task scope."""
    return isinstance(obj, RoleAssignmentORM) and all(kind in ("material", "site") for kind in _values(obj, "scope_kind"))


def _note(session, obj, state):
    """Record whom and what one changed row concerns (see _concerned)."""
    scope = _scope(session)
    users, scopes = scope["users"], scope["scopes"]
    if isinstance(obj, UserORM):
        users.update(_values(obj, "user_id"))
    elif isinstance(obj, BlockORM):
        # A new, removed or renamed block or a changed HR flag moves the HR roles
        # and every member's scope: recheck all.
        if state != "dirty" or _changed(obj, "name") or _changed(obj, "is_hr"):
            scope["full"] = True
        users.update(_values(obj, "master_user_id"))
        for raw in _values(obj, "arr_of_human"):
            users.update(_listed(raw))
        scopes.update(("block", name) for name in _values(obj, "name"))
    elif isinstance(obj, BlockMetaORM):
        if state != "dirty" or _changed(obj, "archived_at"):
            scope["full"] = True
        users.update(_values(obj, "hr_user_id"))
        scopes.update(("block", name) for name in _values(obj, "legacy_name"))
    elif isinstance(obj, EventWorkspaceMetaORM):
        users.update(_values(obj, "hr_user_id"))
        scopes.update(zip(_values(obj, "owner_kind"), _values(obj, "owner_id")))
    elif isinstance(obj, LeadershipORM):
        scope["full"] = True
    elif isinstance(obj, RoleAssignmentORM):
        users.update(_values(obj, "user_id"))
        scopes.update((kind, scope_id) for kind in _values(obj, "scope_kind") for scope_id in _values(obj, "scope_id"))
    elif isinstance(obj, SubeventORM):
        if state == "deleted" or _changed(obj, "event_id"):
            scope["full"] = True
        for raw in _values(obj, "organizer_user_ids_json"):
            users.update(_listed(raw))
        scopes.update(("subevent", sid) for sid in _values(obj, "subevent_id"))
        scopes.update(("event", eid) for eid in _values(obj, "event_id"))
    elif isinstance(obj, TaskQueueORM):
        scope["queues"].update(_values(obj, "queue_id"))
        users.update(_values(obj, "owner_user_id"))
    else:
        scope["full"] = True
