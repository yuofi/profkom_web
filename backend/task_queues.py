"""Task queue grants open public work independently of team membership.

Keys and per-queue numbers are immutable identities; UUID task URLs stay valid.
Explicit queue/task grants never confer private accounting or team authority.
The WEBSUPPORT staff boundary remains a separate mandatory gate.
"""
from contextvars import ContextVar
from dataclasses import asdict
from datetime import datetime, timezone
import json
import re
import uuid

from sqlalchemy import text
from database import (db, engine, SessionLocal, TaskORM, TaskTrackerORM, TaskActivityORM,
    TaskQueueORM, TaskQueueRequestORM, TaskQueueMemberORM, UserORM, BlockORM,
    SubeventORM, EventORM, ContributionORM, AssignmentORM, _user_to_ref_dc, _note_user)
from errors import Forbidden, InvalidInput, NotFound, Conflict, revision_conflict
from read_context import cached, orm_get, prime_get, reusable


def now(): return datetime.now(timezone.utc).isoformat()


def active(session, uid):
    _note_user(uid)
    u=session.get(UserORM,uid)
    return bool(u and not u.banned and u.account_state=='active')


def base_read(uid, queue):
    return queue.scope_kind=="queue" or db.can_view_scope(uid,queue.scope_kind,queue.scope_id)


def can_read(session, queue, uid):
    if not queue or not uid:return False
    key=tuple(getattr(queue,name,None) for name in ("queue_id","key","scope_kind","scope_id","owner_user_id","is_private"))+(uid,)
    return cached(session,"queue.can_read",key,lambda:_can_read(session,queue,uid),copy_result=False)


# The ReaderFacts of the batch deciding can_read (module-level can_read stays the seam).
_reader_facts=ContextVar("task_queues.reader_facts",default=None)


def _can_read_with(facts, session, queue, uid):
    token=_reader_facts.set(facts)
    try:return can_read(session,queue,uid)
    finally:_reader_facts.reset(token)


class ReaderFacts:
    """One reader's account, support and global-role facts for one readable_tasks call.

    A read_context.Calculation: each fact is computed at most once while the session
    is unchanged and dropped at the first change, flush or command, so every decision
    is the one the per-queue/per-task checks make. Never kept after the call.
    """
    def __init__(self, session, uid, calculation=None):
        """``calculation``: one shared by several readers' facts (keys carry the uid)."""
        from read_context import Calculation
        self.session, self.uid = session, uid
        self.calculation = calculation if calculation is not None else Calculation(session)
        self.value = lambda key, load: self.calculation.value((uid, key), load)

    def active(self):
        return self.value("active", lambda: active(self.session, self.uid))

    def support_queue(self, queue):
        from support import support_queue_id
        target = self.calculation.value("support.queue_id", lambda: support_queue_id(self.session))
        return bool(target and queue and queue.queue_id == target)

    def staff(self):
        from support import is_staff
        return self.value("support.staff", lambda: is_staff(self.session, self.uid))

    def all_queue_reader(self):
        from access import all_queue_reader
        return self.value("all_queue_reader", lambda: all_queue_reader(self.uid))

    def can_view_scope(self, kind, scope_id):
        """db.can_view_scope: access.relations with its global part computed once."""
        import access
        def load():
            user = self.value("user", lambda: db.get_user(self.uid))
            if not self.uid or not user or user.account_state != "active" or user.banned:
                rel = frozenset()
            else:
                rel = self.value("global", lambda: access._global_relations(self.uid))
                if kind in access.SCOPES and scope_id is not None:
                    rel = rel | access.scope_relations(self.uid, kind, scope_id)
            return access.allowed(self.uid, "task.view", rel=frozenset(rel))
        return self.value(("scope", kind, scope_id), load)


def _can_read(session, queue, uid):
    facts=_reader_facts.get()
    if facts is not None and (facts.uid != uid or facts.calculation.session is not getattr(session, "session", session)):
        facts = None
    if not queue or not uid or not (facts.active() if facts else active(session,uid)):return False
    from support import is_support_queue, is_staff
    if facts.support_queue(queue) if facts else is_support_queue(session, queue):
        return facts.staff() if facts else is_staff(session, uid)
    from access import all_queue_reader
    if facts.all_queue_reader() if facts else all_queue_reader(uid):return True
    if getattr(queue,'key',None)=='KKR':return False
    grant=orm_get(session,TaskQueueMemberORM,(queue.queue_id,uid))
    if queue.owner_user_id==uid or bool(grant and grant.active):return True
    if facts is None:return base_read(uid,queue) and not queue.is_private
    return (queue.scope_kind=="queue" or facts.can_view_scope(queue.scope_kind,queue.scope_id)) and not queue.is_private


def task_queue(session, task):
    from tracker import _rows
    rows=_rows(session,TaskTrackerORM,task_id=task.task_id)
    meta=rows[0] if rows else None
    return session.get(TaskQueueORM,meta.queue_id) if meta and meta.queue_id else None


def task_read(session, task, uid):
    if not task:return False
    key=(task.task_id,getattr(task,"scope_kind",None),getattr(task,"scope_id",None),uid)
    return cached(session,"queue.task_read",key,lambda:_task_read(session,task,uid),copy_result=False)


def _task_read(session, task, uid):
    from support import owns_task
    if owns_task(session, task.task_id, uid):return True
    queue=task_queue(session,task)
    if queue:
        if can_read(session,queue,uid):return True
        from support import is_support_queue
        if is_support_queue(session,queue):return False
        from tracker_collaboration import has_task_grant
        return has_task_grant(session,task.task_id,uid)
    from access import all_queue_reader
    return all_queue_reader(uid) or db.can_view_scope(uid,task.scope_kind,task.scope_id)  # pre-migration in-memory fixtures


def readers_of(session, task, uids):
    """The users of ``uids`` task_read admits for one task (a comment's fan-out).

    The task's tracker row, queue and support target and the readers' feedback
    ownership, queue grants and task grants are read once for all of them; each
    reader's own facts come from ReaderFacts. Every value belongs to one
    read_context.Calculation: after any change (a modified, deleted or newly added
    row, a flush or command) the remaining readers are decided by task_read itself.
    The decisions are task_read's.
    """
    from read_context import Calculation
    from support_models import FeedbackORM
    from tracker_collaboration_models import TaskAccessGrantORM
    ids = list(dict.fromkeys(uids))
    plain = [uid for uid in ids if isinstance(uid, int) and uid]
    # The comment itself is still unflushed; its row is read by none of these checks.
    calculation = Calculation(session, pending_ok=True)
    if not task or not plain or not calculation.usable():
        return {uid for uid in ids if task_read(session, task, uid)}
    queue = task_queue(session, task)
    owned = {row[0] for row in session.query(FeedbackORM.user_id).filter(
        FeedbackORM.task_id == task.task_id, FeedbackORM.user_id.in_(plain))}
    granted = {row.user_id for row in session.query(TaskAccessGrantORM).filter(
        TaskAccessGrantORM.task_id == task.task_id, TaskAccessGrantORM.active.is_(True),
        TaskAccessGrantORM.user_id.in_(plain))}
    if queue is not None:
        # Loaded grant rows stay in this unit's identity map for _can_read's lookups.
        session.query(TaskQueueMemberORM).filter(TaskQueueMemberORM.queue_id == queue.queue_id,
                                                 TaskQueueMemberORM.user_id.in_(plain)).all()
    support = queue is not None and ReaderFacts(session, None, calculation).support_queue(queue)
    result = set()
    for uid in ids:
        if uid not in plain or not calculation.usable():
            if task_read(session, task, uid):
                result.add(uid)
            continue
        facts = ReaderFacts(session, uid, calculation)
        if uid in owned and facts.active():
            result.add(uid)  # support.owns_task: an active reporter of this task
            continue
        if queue is None:
            if facts.all_queue_reader() or facts.can_view_scope(task.scope_kind, task.scope_id):
                result.add(uid)
            continue
        if _can_read_with(facts, session, queue, uid):
            result.add(uid)
            continue
        if not calculation.usable():
            if task_read(session, task, uid):
                result.add(uid)
            continue
        # Without an active grant row among those read above has_task_grant refuses.
        if not support and uid in granted:
            from tracker_collaboration import has_task_grant
            if has_task_grant(session, task.task_id, uid):
                result.add(uid)
    return result


def readable_tasks(session, tasks, uid, *, known=None, rows=None):
    """Batch materialization of task_read, using the same queue/scope policy.

    Decisions may be reused only by the existing clean read UOW; any command or
    dirty state disables all hints. Support reporters bypass only their own linked
    task; can_read still checks the support staff gate before global roles.
    ``known`` = (tracker rows, queues) the caller already loaded in this clean UOW;
    ``rows`` = this reader's feedback task ids, active grant rows and queue grants
    that readable_tasks_many read for several readers at once (same predicates).
    """
    from sqlalchemy import or_
    from support_models import FeedbackORM
    values=[task for task in tasks if task is not None]
    if not values:return []
    # Reader facts (account, support queue, global roles) once for the whole call.
    facts=ReaderFacts(session,uid)
    identifiers=list(dict.fromkeys(task.task_id for task in values))
    chunks=lambda items: (items[index:index+500] for index in range(0,len(items),500))
    owned=set()
    if rows is not None and not reusable(session):rows=None
    if facts.active() and rows is not None:owned.update(rows["owned"])
    elif facts.active():
        for batch in chunks(identifiers):
            predicate=FeedbackORM.task_id.in_([item for item in batch if item is not None])
            if None in batch:predicate=or_(predicate,FeedbackORM.task_id.is_(None))
            owned.update(row[0] for row in session.query(FeedbackORM.task_id).filter(FeedbackORM.user_id==uid,predicate))
    # Rows a TaskIndex already read in this clean UOW are the same session objects
    # the query below would return; any pending/dirty state ignores them.
    known_metas,known_queues=known if known is not None and reusable(session) else ({},{})
    metadata={task_id:known_metas[task_id] for task_id in identifiers if task_id in known_metas}
    for batch in chunks([task_id for task_id in identifiers if task_id not in metadata]):
        for row in session.query(TaskTrackerORM).filter(TaskTrackerORM.task_id.in_(batch)):
            metadata[row.task_id]=row
    # Match task_queue: a persisted row takes precedence over a pending duplicate.
    wanted=set(identifiers)
    for row in session.new:
        if isinstance(row,TaskTrackerORM) and row.task_id in wanted:
            metadata.setdefault(row.task_id,row)
    queue_ids=list(dict.fromkeys(row.queue_id for row in metadata.values() if row.queue_id))
    from tracker_collaboration_models import TaskAccessGrantORM
    # Prime explicit grants once for the entire selection, including negatives;
    # outsiders must not introduce one SELECT per hidden task.
    granted=set()
    active_grants=set()
    if facts.active():
        found=rows["grants"] if rows is not None else (grant for batch in chunks(identifiers) for grant in session.query(TaskAccessGrantORM).filter(
            TaskAccessGrantORM.user_id==uid,TaskAccessGrantORM.active.is_(True),TaskAccessGrantORM.task_id.in_(batch)))
        for grant in found:
            if grant.task_id not in wanted:continue
            active_grants.add(grant.task_id)
            if grant.source!="control":granted.add(grant.task_id)
    from domain_models import KkrControlEpicORM
    controls=cached(session,"kkr.control_task_ids",None,lambda:frozenset(row[0] for row in session.query(KkrControlEpicORM.task_id)),copy_result=False)
    granted.difference_update(controls)
    for task_id in identifiers:
        if task_id not in controls:cached(session,"task.single_grant",(task_id,uid),lambda task_id=task_id:task_id in granted,copy_result=False)
        # A control without an active grant row is refused by has_task_grant's own
        # check; one with a row keeps the full source-scope check.
        elif task_id not in active_grants:cached(session,"task.single_grant",(task_id,uid),lambda:False,copy_result=False)
    queues={queue_id:known_queues[queue_id] for queue_id in queue_ids if queue_id in known_queues}
    for batch in chunks([queue_id for queue_id in queue_ids if queue_id not in queues]):
        queues.update((row.queue_id,row) for row in session.query(TaskQueueORM).filter(TaskQueueORM.queue_id.in_(batch)))
    # The reader's queue grants for the whole selection, including absent rows,
    # are the same TaskQueueMember PK reads _can_read performs one queue at a time.
    if queue_ids and reusable(session) and facts.active():
        members={}
        for row in (rows["members"] if rows is not None else (row for batch in chunks(queue_ids) for row in session.query(
                TaskQueueMemberORM).filter(TaskQueueMemberORM.user_id==uid,TaskQueueMemberORM.queue_id.in_(batch)))):
            members[row.queue_id]=row
        for queue_id in queue_ids:
            prime_get(session,TaskQueueMemberORM,(queue_id,uid),members.get(queue_id))
    decisions={}
    scope_decisions={}
    global_reader=None
    result=[]
    task_decisions=[]
    for task in values:
        cached(session,"support.owns_task",(task.task_id,uid),
               lambda task=task:task.task_id in owned,copy_result=False)
        if task.task_id in owned:
            result.append(task);task_decisions.append((task,True));continue
        meta=metadata.get(task.task_id)
        queue=queues.get(meta.queue_id) if meta and meta.queue_id else None
        if queue:
            if queue.queue_id not in decisions:decisions[queue.queue_id]=_can_read_with(facts,session,queue,uid)
            allowed=decisions[queue.queue_id]
            if not allowed and not facts.support_queue(queue):
                if task.task_id not in active_grants and facts.calculation.usable():
                    # The grant rows above were read in this unchanged session: no
                    # active row for this task, which has_task_grant would refuse.
                    allowed=False
                else:
                    from tracker_collaboration import has_task_grant
                    allowed=has_task_grant(session,task.task_id,uid)
        else:
            if global_reader is None:global_reader=facts.all_queue_reader()
            key=(task.scope_kind,task.scope_id)
            if global_reader:allowed=True
            else:
                if key not in scope_decisions:scope_decisions[key]=facts.can_view_scope(*key)
                allowed=scope_decisions[key]
        if allowed:result.append(task)
        task_decisions.append((task,allowed))
    for task,allowed in task_decisions:
        key=(task.task_id,getattr(task,"scope_kind",None),getattr(task,"scope_id",None),uid)
        cached(session,"queue.task_read",key,lambda allowed=allowed:bool(allowed),copy_result=False)
    return result


def _json_ids(raw):
    try:return json.loads(raw) if raw else []
    except Exception:return []


def _role_holders(session, kind, scope_ids, roles):
    from database import RoleAssignmentORM
    if not scope_ids:return set()
    return {row[0] for row in session.query(RoleAssignmentORM.user_id).filter(RoleAssignmentORM.scope_kind==kind,
        RoleAssignmentORM.scope_id.in_(list(scope_ids)),RoleAssignmentORM.role.in_(list(roles)))}


def _global_readers(session, ids):
    """all_queue_reader for many active users: the chair, deputies, HR master and HR deputies."""
    from database import LeadershipORM
    from access import _hr_block_names
    leadership=session.get(LeadershipORM,1)
    result={leadership.chair_user_id} if leadership else set()
    deputies=_json_ids(leadership.deputies_json) if leadership else []
    result|={uid for uid in ids if uid in deputies}
    result|={row[0] for row in session.query(BlockORM.master_user_id).filter(BlockORM.is_hr == True)}  # noqa: E712
    result|=_role_holders(session,"block",_hr_block_names(),{"deputy_master"})
    return result


def _scope_viewers(session, kind, scope_id, ids):
    """access.allowed(uid, "task.view", kind, scope_id) through scope relations alone
    (global relations are _global_readers); unknown scope kinds use the exact check."""
    import access
    if kind=="block":
        from domain_models import BlockMetaORM
        name=access.block_name(scope_id)
        if not name:return set()
        block=session.get(BlockORM,name)
        result=set()
        if block:
            result.add(block.master_user_id)
            members=_json_ids(block.arr_of_human)
            result|={uid for uid in ids if uid in members}
        result|=_role_holders(session,"block",[name],{"master","deputy_master"})
        meta=session.query(BlockMetaORM).filter_by(legacy_name=name).one_or_none()
        if meta:result.add(getattr(meta,"hr_user_id",None))
        return result
    if kind=="subevent":
        from event_workspace_models import EventWorkspaceMetaORM
        sub=session.get(SubeventORM,scope_id)
        if not sub:return set()
        organizers=_json_ids(sub.organizer_user_ids_json)
        result={uid for uid in ids if uid in organizers}
        result|=_role_holders(session,"subevent",[scope_id],{"subevent_leader","deputy_subevent_leader"})
        result|=_role_holders(session,"event",[sub.event_id],{"event_leader","deputy_event_leader"})
        meta=session.get(EventWorkspaceMetaORM,("subevent",scope_id))
        if meta:result.add(meta.hr_user_id)
        return result
    if kind=="event":
        children=session.query(SubeventORM.subevent_id,SubeventORM.organizer_user_ids_json).filter_by(event_id=scope_id).all()
        organizers=[uid for _child,raw in children for uid in _json_ids(raw)]
        result={uid for uid in ids if uid in organizers}
        result|=_role_holders(session,"event",[scope_id],{"event_leader","deputy_event_leader"})
        result|=_role_holders(session,"subevent",[child for child,_raw in children],{"subevent_leader","deputy_subevent_leader"})
        return result
    return {uid for uid in ids if db.can_view_scope(uid,kind,scope_id)}


def task_readers(session, task, uids):
    """The users of `uids` for whom task_read(session, task, uid) holds, decided at once.

    The same policy as _task_read and _can_read, with one query per source (support
    reporters and staff, queue grants, scope roles and teams, explicit task grants)
    instead of a dozen ACL queries per user. Nothing is cached across requests.
    """
    from support import is_support_queue, _leaders
    from support_models import FeedbackORM, SupportStaffORM
    ids={uid for uid in uids if uid and active(session,uid)}
    if not task or not ids:return set()
    queue=task_queue(session,task)
    if not queue:return {uid for uid in ids if task_read(session,task,uid)}
    readers={row[0] for row in session.query(FeedbackORM.user_id).filter(FeedbackORM.task_id==task.task_id)}
    if is_support_queue(session,queue):
        staff={row[0] for row in session.query(SupportStaffORM.user_id).filter(SupportStaffORM.active.is_(True))}
        return (readers|staff|_leaders(session))&ids
    readers|=_global_readers(session,ids)
    if queue.key!="KKR":
        readers.add(queue.owner_user_id)
        readers|={row[0] for row in session.query(TaskQueueMemberORM.user_id).filter(TaskQueueMemberORM.queue_id==queue.queue_id,TaskQueueMemberORM.active.is_(True))}
        if not queue.is_private:
            readers|=ids if queue.scope_kind=="queue" else _scope_viewers(session,queue.scope_kind,queue.scope_id,ids)
    from tracker_collaboration_models import TaskAccessGrantORM
    from tracker_collaboration import has_task_grant
    granted={row[0] for row in session.query(TaskAccessGrantORM.user_id).filter(TaskAccessGrantORM.task_id==task.task_id,TaskAccessGrantORM.active.is_(True))}
    readers|={uid for uid in (granted&ids)-readers if has_task_grant(session,task.task_id,uid)}
    return readers&ids


def readable_tasks_many(session, tasks_by_user):
    """readable_tasks for several users in one clean read UOW, sharing tracker rows.

    Each user keeps the ordinary batch policy (support gate, private queues, grants,
    ownership); only the selection's tracker/queue rows are read once. The
    decisions are recorded as task_read hints. No-op outside a clean read UOW.
    """
    if not reusable(session):
        return {}
    tasks = {task.task_id: task for values in tasks_by_user.values() for task in values if task is not None}
    identifiers = list(tasks)
    metas, queues = {}, {}
    for index in range(0, len(identifiers), 500):
        for row in session.query(TaskTrackerORM).filter(TaskTrackerORM.task_id.in_(identifiers[index:index+500])):
            metas[row.task_id] = row
    queue_ids = list(dict.fromkeys(row.queue_id for row in metas.values() if row.queue_id))
    for index in range(0, len(queue_ids), 500):
        queues.update((row.queue_id, row) for row in session.query(TaskQueueORM).filter(
            TaskQueueORM.queue_id.in_(queue_ids[index:index+500])))
    rows = _reader_rows(session, tasks_by_user, metas)
    return {uid: {task.task_id for task in readable_tasks(session, list(values), uid, known=(metas, queues),
                                                         rows=rows.get(uid))}
            for uid, values in tasks_by_user.items() if uid}


def _reader_rows(session, tasks_by_user, metas):
    """Feedback task ids, active grant rows and queue grants of several active readers.

    The same predicates readable_tasks applies per reader, read once with user_id IN
    (...); each reader then keeps only rows for its own selection. Readers absent
    from the result use readable_tasks' own per-reader queries.
    """
    from support_models import FeedbackORM
    from tracker_collaboration_models import TaskAccessGrantORM
    users = [uid for uid in dict.fromkeys(tasks_by_user) if uid and active(session, uid)]
    wanted = {uid: [task.task_id for task in tasks_by_user[uid] if task is not None] for uid in users}
    if len(users) < 2 or any(task_id is None for ids in wanted.values() for task_id in ids):
        return {}
    task_ids = list(dict.fromkeys(task_id for ids in wanted.values() for task_id in ids))
    queue_ids = list(dict.fromkeys(row.queue_id for row in metas.values() if row.queue_id))
    result = {uid: dict(owned=set(), grants=[], members=[]) for uid in users}
    for start in range(0, len(users), 400):
        group = users[start:start + 400]
        for offset in range(0, len(task_ids), 400):
            batch = task_ids[offset:offset + 400]
            for task_id, uid in session.query(FeedbackORM.task_id, FeedbackORM.user_id).filter(
                    FeedbackORM.user_id.in_(group), FeedbackORM.task_id.in_(batch)):
                result[uid]["owned"].add(task_id)
            for grant in session.query(TaskAccessGrantORM).filter(TaskAccessGrantORM.user_id.in_(group),
                    TaskAccessGrantORM.active.is_(True), TaskAccessGrantORM.task_id.in_(batch)):
                result[grant.user_id]["grants"].append(grant)
        for offset in range(0, len(queue_ids), 400):
            for row in session.query(TaskQueueMemberORM).filter(TaskQueueMemberORM.user_id.in_(group),
                    TaskQueueMemberORM.queue_id.in_(queue_ids[offset:offset + 400])):
                result[row.user_id]["members"].append(row)
    for uid in users:
        own = set(wanted[uid])
        result[uid]["owned"] &= own
        result[uid]["grants"] = [grant for grant in result[uid]["grants"] if grant.task_id in own]
    return result


def require_task_read(session, task, uid):
    if not task_read(session,task,uid):raise NotFound('Task not found')


def queue_ref(queue):return dict(queue_id=queue.queue_id,name=queue.name,key=queue.key)


def _letters(number):
    out=''
    while True:
        out=chr(65+number%26)+out;number=number//26-1
        if number<0:return out


PLACEHOLDER_QUEUE_NAME='Задачи команды Команда'
# A Latin capital first, then capitals or digits; lower case is not folded here (owner 2026-11-08, В9).
QUEUE_KEY='[A-Z][A-Z0-9]{0,31}'


def _scope_title(session, kind, scope_id):
    """Default queue names follow the scope's own model; an unknown scope keeps the placeholder."""
    model={'block':BlockORM,'event':EventORM,'subevent':SubeventORM}.get(kind)
    obj=session.get(model,scope_id) if model else None
    return (obj.name if kind=='block' else obj.title) if obj else 'Команда'


def rename_placeholder_event_queues(session):
    """Repeatable: only untouched default event queues named before the event title was resolved."""
    renamed=0
    for q in session.query(TaskQueueORM).filter_by(scope_kind='event',is_default=True,name=PLACEHOLDER_QUEUE_NAME):
        title=_scope_title(session,'event',q.scope_id)
        if title=='Команда':continue
        q.name='Задачи команды '+title;q.revision=(q.revision or 1)+1;renamed+=1
    return renamed


def default_queue(session, kind, scope_id):
    rows=session.query(TaskQueueORM).filter_by(scope_kind=kind,scope_id=scope_id,is_default=True).all()
    rows += [q for q in session.new if isinstance(q,TaskQueueORM) and q.scope_kind==kind and q.scope_id==scope_id and q.is_default and q not in rows]
    if rows:return rows[0]
    title=_scope_title(session,kind,scope_id)
    used={q.key for q in session.query(TaskQueueORM)}|{q.key for q in session.new if isinstance(q,TaskQueueORM)}
    n=0
    while 'Q'+_letters(n) in used:n+=1
    # Legacy owners are only known scope leads; no invented actor or creation date.
    leads=sorted(uid for uid in db.get_scope_leads(kind,scope_id) if active(session,uid) and db.can_view_scope(uid,kind,scope_id))
    q=TaskQueueORM(queue_id='queue-'+str(uuid.uuid4()),name='Задачи команды '+title,key='Q'+_letters(n),
        scope_kind=kind,scope_id=scope_id,owner_user_id=leads[0] if leads else None,
        is_private=False,is_default=True,next_task_number=1,revision=1,created_at=None)
    session.add(q)
    return q


def bind_task(session, task, meta, queue=None):
    if meta.queue_id and meta.queue_number:return
    queue=queue or default_queue(session,task.scope_kind,task.scope_id)
    meta.queue_id=queue.queue_id
    meta.queue_number=queue.next_task_number or 1
    queue.next_task_number=meta.queue_number+1
    if meta.task_number is not None:meta.legacy_task_key='TASK-'+str(meta.task_number)


def migrate_columns():
    """Add columns before loading old ORM metadata; repeatable without public events."""
    with engine.begin() as connection:
        columns={row[1] for row in connection.execute(text('pragma table_info(task_tracker)'))}
        for name,typ in [('queue_id','TEXT'),('queue_number','INTEGER'),('legacy_task_key','TEXT'),('parent_task_id','TEXT'),('roster_initialized','BOOLEAN NOT NULL DEFAULT 0'),('public_revisions_json',"TEXT NOT NULL DEFAULT '{}'"),('assessment_revision','INTEGER NOT NULL DEFAULT 1')]:
            if name not in columns:
                connection.execute(text(f'ALTER TABLE task_tracker ADD COLUMN {name} {typ}'))
                if name=='assessment_revision':connection.execute(text('UPDATE task_tracker SET assessment_revision=(SELECT revision FROM tasks WHERE tasks.task_id=task_tracker.task_id)'))
        columns={row[1] for row in connection.execute(text('pragma table_info(task_activity)'))}
        if 'changes_json' not in columns:connection.execute(text("ALTER TABLE task_activity ADD COLUMN changes_json TEXT NOT NULL DEFAULT '[]'"))
        connection.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS uq_task_queue_number ON task_tracker(queue_id,queue_number)'))


def migrate():
    with SessionLocal() as session:
        session.info['tracker_batch']=True
        for task in session.query(TaskORM).order_by(TaskORM.created_at,TaskORM.task_id):
            meta=session.query(TaskTrackerORM).filter_by(task_id=task.task_id).one()
            bind_task(session,task,meta)
        rename_placeholder_event_queues(session)
        session.commit()


def _self_request(session, queue, uid):
    from read_context import orm_rows
    def load():
        row=session.query(TaskQueueRequestORM).filter_by(queue_id=queue.queue_id,user_id=uid).order_by(TaskQueueRequestORM.created_at.desc(),TaskQueueRequestORM.request_id.desc()).first()
        return [row] if row is not None else []
    rows=orm_rows(session,"queue.self_request",(queue.queue_id,uid),load)
    return rows[0] if rows else None


def _prime_catalog(session, queues, uid):
    """The reader's own queue grants and latest access requests for a catalogue page.

    One query each, in the same order as the per-queue reads, recorded (including
    absent rows) only for this clean read UOW. Policies and projections are unchanged.
    """
    from read_context import prime_rows
    if not queues or not uid or not reusable(session):return
    members={row.queue_id:row for row in session.query(TaskQueueMemberORM).filter(TaskQueueMemberORM.user_id==uid)}
    latest={}
    for row in session.query(TaskQueueRequestORM).filter(TaskQueueRequestORM.user_id==uid).order_by(
            TaskQueueRequestORM.created_at.desc(),TaskQueueRequestORM.request_id.desc()):
        latest.setdefault(row.queue_id,row)
    for queue in queues:
        prime_get(session,TaskQueueMemberORM,(queue.queue_id,uid),members.get(queue.queue_id))
        prime_rows(session,"queue.self_request",(queue.queue_id,uid),[latest[queue.queue_id]] if queue.queue_id in latest else [])


def projection(session, queue, uid, *, include_assignable=True):
    import access
    granted=can_read(session,queue,uid)
    request=_self_request(session,queue,uid)
    caps=[]
    from support import is_support_queue
    if granted and not is_support_queue(session,queue):caps.append('create_task')
    if granted and queue.scope_kind!='queue' and access.allowed(uid,'task.assign_others',queue.scope_kind,queue.scope_id):caps.append('assign_task_others')
    from support import is_support_queue
    if granted and queue.owner_user_id==uid and not is_support_queue(session,queue):caps+=['manage_queue','view_queue_requests']
    from support import is_support_queue
    managed_control=queue.key=='KKR'
    if managed_control:caps=[]
    can_request=not managed_control and not is_support_queue(session,queue) and not granted and active(session,uid) and (not request or request.status!='pending')
    if can_request:caps.append('request_queue_access')
    if not managed_control and request and request.status=='pending' and request.user_id==uid:caps.append('cancel_queue_access_request')
    result=dict(**queue_ref(queue),access='granted' if granted else 'locked',capabilities=caps,
        can_request_access=can_request,access_request_status=request.status if request else None,
        access_request_id=request.request_id if request else None,access_request_revision=request.revision if request else None)
    if granted:
        from models import ScopeRef
        from membership import scope_out
        if queue.owner_user_id:_note_user(queue.owner_user_id)
        owner=_user_to_ref_dc(session.get(UserORM,queue.owner_user_id)) if queue.owner_user_id else None
        if include_assignable and 'assign_task_others' in caps:
            result['assignable_users']=[asdict(_user_to_ref_dc(u)) for u in session.query(UserORM) if active(session,u.user_id) and can_read(session,queue,u.user_id) and db.is_member_or_leader_in_scope(u.user_id,queue.scope_kind,queue.scope_id)]
        from queue_ownership import owner_available
        result.update(scope=None if queue.scope_kind=="queue" else scope_out(ScopeRef(kind=queue.scope_kind,id=queue.scope_id)),
            owner=asdict(owner) if owner else None,owner_unavailable=not owner_available(session,queue),
            is_private=queue.is_private,revision=queue.revision,created_at=queue.created_at)
    return result


def get(queue_id,uid,*,include_assignable=True):
    with db._session() as session:
        queue=session.get(TaskQueueORM,queue_id)
        if not queue:raise NotFound('Queue not found')
        result=projection(session,queue,uid,include_assignable=include_assignable)
        if result['access']=='locked':
            raise Forbidden('Queue access is required','queue_access_required',queue=queue_ref(queue),
                can_request_access=result['can_request_access'],access_request_status=result['access_request_status'],
                access_request_id=result['access_request_id'],access_request_revision=result['access_request_revision'])
        return result


def assignment_task_ids(uid, assignment_ids):
    """assignment_id -> task_id when uid reads that task (GET /tasks/{id}), else None.

    For links from accounting rows: a task in a queue the reader cannot open keeps
    its id hidden. Two IN reads; decisions use task_read, primed in a clean read UOW.
    """
    ids=list(dict.fromkeys(item for item in assignment_ids if item))
    if not ids:return {}
    with db._session() as session:
        pairs={}
        for index in range(0,len(ids),500):
            pairs.update(session.query(AssignmentORM.assignment_id,AssignmentORM.task_id).filter(
                AssignmentORM.assignment_id.in_(ids[index:index+500])))
        task_ids=list(dict.fromkeys(pairs.values()))
        tasks={}
        for index in range(0,len(task_ids),500):
            tasks.update((task.task_id,task) for task in session.query(TaskORM).filter(TaskORM.task_id.in_(task_ids[index:index+500])))
        if reusable(session):readable_tasks(session,list(tasks.values()),uid)
        readable={task_id for task_id,task in tasks.items() if db.can_read_task(uid,task,session)}
        return {assignment_id:(task_id if task_id in readable else None) for assignment_id,task_id in pairs.items()}


def create_access(uid):
    """Whether any catalogue queue carries create_task for the reader (the projection rule)."""
    from support import is_support_queue
    with db._session() as session:
        rows=session.query(TaskQueueORM).all() if active(session,uid) else []
        _prime_catalog(session,rows,uid)
        return dict(can_create_task=any(queue.key!='KKR' and can_read(session,queue,uid) and not is_support_queue(session,queue) for queue in rows))


def catalog(uid,cursor=None):
    import access
    from api_contract import cursor_page
    from membership import scope_out
    from models import ScopeRef
    with db._session() as session:
        rows=session.query(TaskQueueORM).all() if active(session,uid) else []
        page=cursor_page(rows,lambda q:(q.key,q.queue_id),cursor)
        _prime_catalog(session,page.items,uid)
        scopes=[]
        if access.allowed(uid,'queue.create','chair','chair'):
            scopes.append(dict(kind='chair',id='chair',title='Председатель'))
        for kind,objects in [('event',session.query(EventORM).all()),('block',session.query(BlockORM).all()),('subevent',session.query(SubeventORM).all())]:
            for obj in objects:
                sid=obj.name if kind=='block' else obj.event_id if kind=='event' else obj.subevent_id
                if access.allowed(uid,'queue.create',kind,sid):
                    scopes.append(dict(**scope_out(ScopeRef(kind=kind,id=sid)),title=obj.name if kind=='block' else obj.title))
        priority={'chair':0,'event':1,'block':2,'subevent':3}
        return dict(items=[projection(session,q,uid,include_assignable=False) for q in page.items],next_cursor=page.next_cursor,can_create_queue=active(session,uid) and bool(scopes),
            create_scopes=sorted(scopes,key=lambda s:(priority[s['kind']],s['title'],s['id'])))


def _validate_owner(session,uid,kind,sid):
    if not active(session,uid) or (kind!='queue' and not db.can_view_scope(uid,kind,sid)):raise InvalidInput('Queue owner must be an active member or scope reader')


def create(uid,name,key,scope=None,owner_user_id=None,is_private=False):
    from membership import legacy_name
    scope=scope or {};kind=scope.get('kind');sid=scope.get('id')
    if kind=='block':sid=legacy_name(sid)
    if not scope:kind='chair';sid='chair'
    if kind not in ('block','subevent','event','chair') or not sid:raise InvalidInput('Invalid queue scope')
    with db._session() as session:
        import access
        if not active(session,uid):raise Forbidden('Only active approved users may create queues')
        if not access.allowed(uid,'queue.create',kind,sid):raise Forbidden('Only leaders may create queues in their own teams')
        if owner_user_id is not None and owner_user_id!=uid:raise InvalidInput('Queue creator must be its initial owner')
        qid='queue-'+str(uuid.uuid4())
        if kind=='chair':
            if sid!='chair':raise InvalidInput('Invalid chair scope')
        else:
            scope_object=session.get(BlockORM,sid) if kind=='block' else session.get(EventORM,sid) if kind=='event' else session.get(SubeventORM,sid)
            if not scope_object:raise NotFound('Queue scope not found')
            if not db.can_view_scope(uid,kind,sid):raise Forbidden('Cannot create queue outside a readable scope')
        if not name.strip():raise InvalidInput('Queue name is required')
        if not re.fullmatch(QUEUE_KEY,key):raise InvalidInput('Queue key must start with an uppercase ASCII letter followed by uppercase ASCII letters or digits')
        if key=='KKR':raise Conflict('Queue key KKR is reserved for accounting control','control_queue_conflict')
        if key=='WEBSUPPORT':raise Conflict('Queue key WEBSUPPORT is reserved for website support','queue_key_conflict')
        if session.query(TaskQueueORM).filter_by(key=key).first():raise Conflict('Queue key already exists','queue_key_conflict')
        q=TaskQueueORM(queue_id=qid,name=name.strip(),key=key,scope_kind=kind,scope_id=sid,
            owner_user_id=uid,is_private=is_private,is_default=False,next_task_number=1,revision=1,created_at=now())
        session.add(q);session.commit()
        return projection(session,q,uid)


def managed(session,queue_id,uid):
    q=session.get(TaskQueueORM,queue_id)
    if not q:raise NotFound('Queue not found')
    if q.key=='KKR':raise Conflict('Control queue is managed automatically','control_epic_managed')
    from support import is_support_queue
    if is_support_queue(session,q):raise Forbidden('Use support settings to manage this queue')
    if not can_read(session,q,uid) or q.owner_user_id!=uid:raise Forbidden('Only the queue owner can manage this queue')
    return q


def patch(queue_id,uid,expected_revision,**values):
    with db._session() as session:
        q=managed(session,queue_id,uid)
        if q.revision!=expected_revision:raise revision_conflict()
        if 'name' in values:
            if not values['name'].strip():raise InvalidInput('Queue name is required')
            q.name=values['name'].strip()
        previous_owner=q.owner_user_id
        if 'owner_user_id' in values:
            _validate_owner(session,values['owner_user_id'],q.scope_kind,q.scope_id);q.owner_user_id=values['owner_user_id']
        if 'is_private' in values:q.is_private=values['is_private']
        q.revision+=1
        if q.owner_user_id!=previous_owner:
            from database import AuditLogORM
            session.add(AuditLogORM(target_kind='task_queue',target_id=q.queue_id,changed_by_user_id=uid,
                reason='Queue ownership transferred',old_values_json=json.dumps({'owner_user_id':previous_owner}),
                new_values_json=json.dumps({'owner_user_id':q.owner_user_id,'automatic':False,'queue_revision':q.revision}),created_at=now()))
        session.commit()
        return projection(session,q,uid)


def request_projection(session,row,owner_uid):
    grant=session.get(TaskQueueMemberORM,(row.queue_id,row.user_id))
    granted=bool(grant and grant.active and grant.request_id==row.request_id)
    caps=['approve_queue_access','reject_queue_access'] if row.status=='pending' else []
    if granted:caps.append('revoke_queue_access')
    ref=_user_to_ref_dc(session.get(UserORM,row.user_id))
    return dict(request_id=row.request_id,user=asdict(ref) if ref else None,message=row.message,status=row.status,
        created_at=row.created_at,revision=row.revision,capabilities=caps,access_granted=granted)


def request_access(queue_id,uid,message=''):
    from notifications import emit
    with db._session() as session:
        q=session.get(TaskQueueORM,queue_id)
        if not q:raise NotFound('Queue not found')
        if q.key=='KKR':raise Conflict('Control queue access is managed automatically','control_epic_managed')
        if not active(session,uid):raise Forbidden('Only active users may request queue access')
        from support import is_support_queue
        if is_support_queue(session,q):raise Forbidden('Support access is delegated by its leaders')
        if can_read(session,q,uid):raise Conflict('Queue access is already granted')
        current=_self_request(session,q,uid)
        if current and current.status=='pending':return projection(session,q,uid)
        row=TaskQueueRequestORM(request_id='queue-request-'+str(uuid.uuid4()),queue_id=queue_id,user_id=uid,
            message=message.strip(),status='pending',created_at=now(),revision=1)
        session.add(row)
        emit(session,[q.owner_user_id] if q.owner_user_id else [],'task_queue_access_request',
            dict(queue_id=q.queue_id,request_id=row.request_id,title=q.name),'queue-request:'+row.request_id,uid)
        session.commit()
        return projection(session,q,uid)


def requests(queue_id,uid,cursor=None):
    from api_contract import cursor_page
    with db._session() as session:
        managed(session,queue_id,uid)
        rows=session.query(TaskQueueRequestORM).filter_by(queue_id=queue_id).all()
        page=cursor_page(rows,lambda r:(r.created_at,r.request_id),cursor,descending=True)
        return dict(items=[request_projection(session,r,uid) for r in page.items],next_cursor=page.next_cursor)


def cancel_request(queue_id,request_id,uid,expected_revision):
    """Only the requester can withdraw their still pending access request."""
    with db._session() as session:
        row=session.get(TaskQueueRequestORM,request_id)
        if not row or row.queue_id!=queue_id or row.user_id!=uid:raise NotFound('Access request not found')
        if row.revision!=expected_revision:raise revision_conflict()
        if row.status!='pending':raise Conflict('Access request is no longer pending')
        row.status='cancelled';row.decided_at=now();row.decided_by_user_id=uid;row.revision+=1
        session.commit()
        queue=session.get(TaskQueueORM,queue_id)
        return projection(session,queue,uid)


def decide(queue_id,request_id,uid,expected_revision,approve):
    from notifications import emit
    with db._session() as session:
        q=managed(session,queue_id,uid)
        row=session.get(TaskQueueRequestORM,request_id)
        if not row or row.queue_id!=queue_id:raise NotFound('Access request not found')
        if row.revision!=expected_revision:raise revision_conflict()
        if row.status!='pending':raise Conflict('Access request has already been decided')
        if not active(session,row.user_id):raise InvalidInput('Requester is no longer active')
        row.status='approved' if approve else 'rejected';row.decided_at=now();row.decided_by_user_id=uid;row.revision+=1
        if approve:
            grant=session.get(TaskQueueMemberORM,(queue_id,row.user_id))
            if not grant:grant=TaskQueueMemberORM(queue_id=queue_id,user_id=row.user_id);session.add(grant)
            grant.request_id=request_id;grant.active=True;grant.granted_at=now();grant.granted_by_user_id=uid;grant.revoked_at=None
        emit(session,[row.user_id],'task_queue_access_decision',dict(queue_id=queue_id,title=q.name,status=row.status),
            'queue-request:'+request_id+':'+row.status,uid)
        session.commit();return request_projection(session,row,uid)


def revoke(queue_id,user_id,uid,expected_revision):
    with db._session() as session:
        managed(session,queue_id,uid)
        grant=session.get(TaskQueueMemberORM,(queue_id,user_id))
        if not grant or not grant.active:raise NotFound('Active queue grant not found')
        row=session.get(TaskQueueRequestORM,grant.request_id)
        if row.revision!=expected_revision:raise revision_conflict()
        grant.active=False;grant.revoked_at=now();row.revision+=1
        session.commit();return request_projection(session,row,uid)


def validate_parent(session,task_id,season_id,parent_task_id,uid):
    if parent_task_id is None:return
    parent=session.get(TaskORM,parent_task_id)
    if not parent or not task_read(session,parent,uid):raise NotFound('Parent task not found')
    from tracker import is_control_task
    if is_control_task(session,parent_task_id):raise Conflict('Control epics cannot be parent tasks','control_epic_managed')
    if parent.season_id!=season_id:raise InvalidInput('Parent task must belong to the same season')
    seen={task_id};current=parent_task_id
    while current:
        if current in seen:raise InvalidInput('Task hierarchy cannot contain a cycle')
        seen.add(current)
        meta=session.query(TaskTrackerORM).filter_by(task_id=current).first()
        current=meta.parent_task_id if meta else None


def hidden_summary_sources(session,season_id,uid):
    from membership import block_id_for
    hidden=set()
    tasks=session.query(TaskORM).filter_by(season_id=season_id).all()
    # A mark command is a write UOW, so the read-only memo intentionally cannot
    # help it. Materialize the same policy in one bounded, command-local batch.
    visible={task.task_id for task in readable_tasks(session,tasks,uid)}
    for task in tasks:
        if task.task_id in visible:continue
        kind='block_task' if task.scope_kind=='block' else 'subevent_task'
        hidden.add((kind,task.scope_id))
        if task.scope_kind=='block':hidden.add((kind,block_id_for(task.scope_id)))
    return hidden


def mask_summary(session,summary,uid):
    """Mask only inaccessible source groups; preserve visible approved projections.

    Numeric totals and persisted snapshots are never changed by this projection.
    """
    hidden=hidden_summary_sources(session,summary.season_id,uid)
    for row in summary.rows:
        for source in row.source_scores:
            if (source.source_kind,source.source_id) in hidden:
                source.title='Задачи блока' if source.source_kind=='block_task' else 'Задачи подмероприятия'
    return summary


def opaque_credit_id(value):
    import hashlib
    return 'private-credit-'+hashlib.sha256(value.encode()).hexdigest()[:32]


def mask_snapshot_summary(session,data,season_id,uid):
    hidden=hidden_summary_sources(session,season_id,uid)
    for row in data.get('rows',[]):
        for source in row.get('source_scores',[]):
            if (source.get('source_kind'),source.get('source_id')) in hidden:
                source['title']='Задачи блока' if source['source_kind']=='block_task' else 'Задачи подмероприятия'
    return data


def mask_snapshot_contributions(session,items,uid):
    for item in items:
        if item.get('source_kind') not in {'block_task','subevent_task'}:continue
        raw=session.get(ContributionORM,item.get('contribution_id'))
        assignment=session.get(AssignmentORM,raw.assignment_id) if raw and raw.assignment_id else None
        task=session.get(TaskORM,assignment.task_id) if assignment else None
        if not task or not task_read(session,task,uid):
            item['source_title']='Закрытая задача'
            item['contribution_id']=opaque_credit_id(item['contribution_id'])
    return items
