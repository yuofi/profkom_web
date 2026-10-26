"""Task queue ACL is an additional restriction, never a replacement for scope policy.

Keys and per-queue numbers are immutable identities; existing UUID task URLs stay valid.
Requests/grants are durable internal records. An approved request grants no block or
organizer membership. Every read/write/file access intersects the original scope ACL.
"""
from dataclasses import asdict
from datetime import datetime, timezone
import json
import re
import uuid

from sqlalchemy import text
from database import (db, engine, SessionLocal, TaskORM, TaskTrackerORM, TaskActivityORM,
    TaskQueueORM, TaskQueueRequestORM, TaskQueueMemberORM, UserORM, BlockORM,
    SubeventORM, ContributionORM, AssignmentORM, _user_to_ref_dc)
from errors import Forbidden, InvalidInput, NotFound, Conflict, revision_conflict


def now(): return datetime.now(timezone.utc).isoformat()


def active(session, uid):
    u=session.get(UserORM,uid)
    return bool(u and not u.banned and u.account_state=='active')


def base_read(uid, queue):
    return db.can_view_scope(uid,queue.scope_kind,queue.scope_id)


def can_read(session, queue, uid):
    if not queue or not uid or not active(session,uid) or not base_read(uid,queue):return False
    grant=session.get(TaskQueueMemberORM,(queue.queue_id,uid))
    return not queue.is_private or queue.owner_user_id==uid or bool(grant and grant.active)


def task_queue(session, task):
    meta=session.query(TaskTrackerORM).filter_by(task_id=task.task_id).first()
    if not meta:
        meta=next((m for m in session.new if isinstance(m,TaskTrackerORM) and m.task_id==task.task_id),None)
    return session.get(TaskQueueORM,meta.queue_id) if meta and meta.queue_id else None


def task_read(session, task, uid):
    if not task or not db.can_view_scope(uid,task.scope_kind,task.scope_id):return False
    queue=task_queue(session,task)
    return can_read(session,queue,uid) if queue else True  # pre-migration in-memory fixtures


def require_task_read(session, task, uid):
    if not task_read(session,task,uid):raise NotFound('Task not found')


def queue_ref(queue):return dict(queue_id=queue.queue_id,name=queue.name,key=queue.key)


def _letters(number):
    out=''
    while True:
        out=chr(65+number%26)+out;number=number//26-1
        if number<0:return out


def default_queue(session, kind, scope_id):
    rows=session.query(TaskQueueORM).filter_by(scope_kind=kind,scope_id=scope_id,is_default=True).all()
    rows += [q for q in session.new if isinstance(q,TaskQueueORM) and q.scope_kind==kind and q.scope_id==scope_id and q.is_default and q not in rows]
    if rows:return rows[0]
    obj=session.get(BlockORM,scope_id) if kind=='block' else session.get(SubeventORM,scope_id)
    title=(obj.name if kind=='block' else obj.title) if obj else 'Команда'
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
        for name,typ in [('queue_id','TEXT'),('queue_number','INTEGER'),('legacy_task_key','TEXT'),('parent_task_id','TEXT')]:
            if name not in columns:connection.execute(text(f'ALTER TABLE task_tracker ADD COLUMN {name} {typ}'))
        columns={row[1] for row in connection.execute(text('pragma table_info(task_activity)'))}
        if 'changes_json' not in columns:connection.execute(text("ALTER TABLE task_activity ADD COLUMN changes_json TEXT NOT NULL DEFAULT '[]'"))
        connection.execute(text('CREATE UNIQUE INDEX IF NOT EXISTS uq_task_queue_number ON task_tracker(queue_id,queue_number)'))


def migrate():
    with SessionLocal() as session:
        session.info['tracker_batch']=True
        for task in session.query(TaskORM).order_by(TaskORM.created_at,TaskORM.task_id):
            meta=session.query(TaskTrackerORM).filter_by(task_id=task.task_id).one()
            bind_task(session,task,meta)
        session.commit()


def _self_request(session, queue, uid):
    return session.query(TaskQueueRequestORM).filter_by(queue_id=queue.queue_id,user_id=uid).order_by(TaskQueueRequestORM.created_at.desc(),TaskQueueRequestORM.request_id.desc()).first()


def projection(session, queue, uid):
    import access
    granted=can_read(session,queue,uid)
    request=_self_request(session,queue,uid)
    caps=[]
    if granted and access.allowed(uid,'task.create',queue.scope_kind,queue.scope_id):caps.append('create_task')
    if granted and queue.owner_user_id==uid:caps+=['manage_queue','view_queue_requests']
    can_request=not granted and active(session,uid) and (not request or request.status!='pending')
    if can_request:caps.append('request_queue_access')
    result=dict(**queue_ref(queue),access='granted' if granted else 'locked',capabilities=caps,
        can_request_access=can_request,access_request_status=request.status if request else None)
    if granted:
        from models import ScopeRef
        from membership import scope_out
        owner=_user_to_ref_dc(session.get(UserORM,queue.owner_user_id)) if queue.owner_user_id else None
        result.update(scope=scope_out(ScopeRef(kind=queue.scope_kind,id=queue.scope_id)),
            owner=asdict(owner) if owner else None,is_private=queue.is_private,revision=queue.revision,created_at=queue.created_at)
    return result


def get(queue_id,uid):
    with db._session() as session:
        queue=session.get(TaskQueueORM,queue_id)
        if not queue:raise NotFound('Queue not found')
        result=projection(session,queue,uid)
        if result['access']=='locked':
            raise Forbidden('Queue access is required','queue_access_required',queue=queue_ref(queue),
                can_request_access=result['can_request_access'],access_request_status=result['access_request_status'])
        return result


def catalog(uid,cursor=None):
    import access
    from api_contract import cursor_page
    from membership import scope_out
    from models import ScopeRef
    with db._session() as session:
        rows=session.query(TaskQueueORM).all() if active(session,uid) else []
        page=cursor_page(rows,lambda q:(q.key,q.queue_id),cursor)
        scopes=[]
        for kind,objects in [('block',session.query(BlockORM).all()),('subevent',session.query(SubeventORM).all())]:
            for obj in objects:
                sid=obj.name if kind=='block' else obj.subevent_id
                if access.allowed(uid,'task.create',kind,sid):
                    scopes.append(dict(**scope_out(ScopeRef(kind=kind,id=sid)),title=obj.name if kind=='block' else obj.title))
        return dict(items=[projection(session,q,uid) for q in page.items],next_cursor=page.next_cursor,
            create_scopes=sorted(scopes,key=lambda s:(s['title'],s['id'])))


def _validate_owner(session,uid,kind,sid):
    if not active(session,uid) or not db.can_view_scope(uid,kind,sid):raise InvalidInput('Queue owner must be an active member or scope reader')


def create(uid,name,key,scope,owner_user_id,is_private=False):
    import access
    from membership import legacy_name
    kind=scope.get('kind');sid=scope.get('id')
    if kind=='block':sid=legacy_name(sid)
    if kind not in ('block','subevent') or not sid:raise InvalidInput('Invalid queue scope')
    with db._session() as session:
        scope_object=session.get(BlockORM,sid) if kind=='block' else session.get(SubeventORM,sid)
        if not scope_object:raise NotFound('Queue scope not found')
        if not access.allowed(uid,'task.create',kind,sid):raise Forbidden('Cannot create queue in this scope')
        if not name.strip():raise InvalidInput('Queue name is required')
        if not re.fullmatch('[A-Z]+',key):raise InvalidInput('Queue key must contain uppercase ASCII letters only')
        if session.query(TaskQueueORM).filter_by(key=key).first():raise Conflict('Queue key already exists','queue_key_conflict')
        _validate_owner(session,owner_user_id,kind,sid)
        q=TaskQueueORM(queue_id='queue-'+str(uuid.uuid4()),name=name.strip(),key=key,scope_kind=kind,scope_id=sid,
            owner_user_id=owner_user_id,is_private=is_private,is_default=False,next_task_number=1,revision=1,created_at=now())
        session.add(q);session.commit()
        return projection(session,q,uid)


def managed(session,queue_id,uid):
    q=session.get(TaskQueueORM,queue_id)
    if not q:raise NotFound('Queue not found')
    if not can_read(session,q,uid) or q.owner_user_id!=uid:raise Forbidden('Only the queue owner can manage this queue')
    return q


def patch(queue_id,uid,expected_revision,**values):
    with db._session() as session:
        q=managed(session,queue_id,uid)
        if q.revision!=expected_revision:raise revision_conflict()
        if 'name' in values:
            if not values['name'].strip():raise InvalidInput('Queue name is required')
            q.name=values['name'].strip()
        if 'owner_user_id' in values:
            _validate_owner(session,values['owner_user_id'],q.scope_kind,q.scope_id);q.owner_user_id=values['owner_user_id']
        if 'is_private' in values:q.is_private=values['is_private']
        q.revision+=1;session.commit()
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
        if not active(session,uid):raise Forbidden('Only active users may request queue access')
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
    for task in session.query(TaskORM).filter_by(season_id=season_id):
        if task_read(session,task,uid):continue
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
