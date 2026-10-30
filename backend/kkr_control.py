"""Season-long accounting control tickets. Commands, never GETs, maintain them."""
from collections import defaultdict
from dataclasses import asdict
import json
import uuid
from fastapi import Depends
import access
from models import User
from database import (db, SeasonORM, BlockORM, EventORM, SubeventORM, LeadershipORM,
    RoleAssignmentORM, TaskORM, TaskTrackerORM, TaskQueueORM, TaskRosterORM,
    AssignmentORM, TaskLinkORM, UserORM, _user_to_ref_dc)
from domain_models import BlockMetaORM, KkrControlEpicORM
from errors import Forbidden, NotFound, Conflict
from datetime import datetime, timezone

def now():
    return datetime.now(timezone.utc).isoformat()


def _active(session, uid):
    from task_queues import active
    return bool(uid and active(session, uid))


def _roles(session, role, kind, sid):
    return {r.user_id for r in session.query(RoleAssignmentORM).filter_by(role=role, scope_kind=kind, scope_id=sid)
            if _active(session, r.user_id)}


def _hr(session):
    blocks = session.query(BlockORM).filter_by(is_hr=True).all()
    masters = {b.master_user_id for b in blocks if _active(session, b.master_user_id)}
    deputies = set()
    for block in blocks:
        deputies |= _roles(session, 'deputy_master', 'block', block.name)
    return masters, deputies


def _scopes(session, season_id):
    leadership = session.get(LeadershipORM, 1)
    chair = leadership.chair_user_id if leadership and _active(session, leadership.chair_user_id) else None
    for block in session.query(BlockORM):
        meta = session.query(BlockMetaORM).filter_by(legacy_name=block.name).first()
        if meta:
            yield 'block', meta.block_id, block.name, block.name, {block.master_user_id} if _active(session, block.master_user_id) else set(), set()
    for event in session.query(EventORM).filter_by(season_id=season_id):
        heads = _roles(session, access.EVENT_LEADER, 'event', event.event_id)
        yield 'event', event.event_id, event.title, event.event_id, heads, set()
        for sub in session.query(SubeventORM).filter_by(event_id=event.event_id):
            leaders = _roles(session, 'subevent_leader', 'subevent', sub.subevent_id)
            yield 'subevent', sub.subevent_id, sub.title, sub.subevent_id, leaders, heads
    yield 'chair', 'chair', 'Работа председателя', 'chair', {chair} if chair else set(), set()


def sync_for_season(session, season_id, actor_uid=None, already_changed_task_ids=()):
    marker='kkr_control_reconciling'
    was_running=session.info.get(marker)
    session.info[marker]=True
    try:
        result=_sync_for_season(session,season_id,actor_uid,already_changed_task_ids)
        session.info.setdefault('kkr_control_synced_seasons',set()).add(season_id)
        return result
    finally:
        if not was_running:session.info.pop(marker,None)


def _sync_for_season(session, season_id, actor_uid=None, already_changed_task_ids=()):
    season = session.get(SeasonORM, season_id)
    if not season or season.state not in {'open', 'summarizing'}:
        return
    masters, deputies = _hr(session)
    leadership = session.get(LeadershipORM, 1)
    owner = next(iter(sorted(masters)), None) or (leadership.chair_user_id if leadership and _active(session, leadership.chair_user_id) else None)
    if not owner:
        return  # An absent HR/chair is observable; never invent an owner identity.
    actor = actor_uid if _active(session, actor_uid) else owner
    queue = session.query(TaskQueueORM).filter_by(key='KKR').first()
    if queue is not None and not session.query(KkrControlEpicORM).filter_by(queue_id=queue.queue_id).first():
        raise Conflict('The reserved KKR key belongs to an existing user queue; resolve the collision explicitly','control_queue_conflict')
    if queue is None:
        queue = TaskQueueORM(queue_id='queue-'+str(uuid.uuid4()), name='Контроль заполнения ККР', key='KKR',
            scope_kind='chair', scope_id='chair', owner_user_id=owner, is_private=True, is_default=False,
            next_task_number=1, revision=1, created_at=now())
        session.add(queue); session.flush()
    if not queue.is_private:
        queue.is_private=True;queue.revision+=1
    if queue.owner_user_id != owner:
        queue.owner_user_id=owner; queue.revision+=1
    from tracker import activity, public_status
    from tracker_collaboration import grant_task_access
    touched = set(already_changed_task_ids)
    control_ids = {r.task_id for r in session.query(KkrControlEpicORM)}
    for kind, identity, title, scope_id, assignees, extra_watchers in _scopes(session, season_id):
        control = session.query(KkrControlEpicORM).filter_by(season_id=season_id, source_kind=kind, source_id=identity).first()
        if control is None:
            stamp=now(); task_id='task-'+str(uuid.uuid4())
            task=TaskORM(task_id=task_id, season_id=season_id, scope_kind=kind, scope_id=scope_id,
                title='ККР · '+title+' · '+season.title, description_json=json.dumps(dict(format='markdown',body='Контроль заполнения ККР закрытых задач сезона. Эпик остаётся открытым до завершения сезона.'),ensure_ascii=False),
                assigned_at=stamp, deadline_at=season.ends_at, created_by_user_id=owner, created_at=stamp, revision=1)
            session.add(task)
            session.add(TaskTrackerORM(task_id=task_id,status='open',task_type='epic',priority='normal',queue_id=queue.queue_id,
                queue_number=queue.next_task_number,roster_initialized=True,assessment_revision=1,files_json='[]'))
            queue.next_task_number+=1
            control=KkrControlEpicORM(control_id='control-'+str(uuid.uuid4()),season_id=season_id,source_kind=kind,source_id=identity,
                task_id=task_id,queue_id=queue.queue_id,managed_json='{}',created_at=stamp)
            session.add(control);session.flush();control_ids.add(task_id)
            touched.add(task_id)
            activity(session,task,'created',actor,'Создан сезонный контроль ККР')
        task=session.get(TaskORM,control.task_id)
        old=json.loads(control.managed_json or '{}')
        desired={uid:'watcher' for uid in masters|deputies|extra_watchers}
        desired.update({uid:'assignee' for uid in assignees})
        changed=False
        for uid in set(old.get('users',[]))|set(desired):
            member=session.get(TaskRosterORM,(task.task_id,int(uid)))
            role=desired.get(int(uid),'left')
            if not member and role!='left':
                member=TaskRosterORM(task_id=task.task_id,user_id=int(uid),created_at=now(),role=role);session.add(member);changed=True
            if member and member.role!=role:
                member.role=role;member.updated_at=now();changed=True
            if member and role=='assignee' and not member.assignment_id:
                assignment=AssignmentORM(assignment_id='assignment-'+str(uuid.uuid4()),task_id=task.task_id,
                    assignee_user_id=int(uid),status='assigned',hours=None,revision=1,inputs_revision=1,created_at=now())
                session.add(assignment);session.flush();member.assignment_id=assignment.assignment_id;changed=True
            if role!='left':
                from tracker_collaboration_models import TaskAccessGrantORM
                existing_grant=session.get(TaskAccessGrantORM,(task.task_id,int(uid)))
                if not existing_grant or not existing_grant.active:
                    grant_task_access(session,task.task_id,int(uid),actor,source='control')
        control.managed_json=json.dumps(dict(users=sorted(desired)))
        if changed:
            if task.task_id not in touched:task.revision+=1;touched.add(task.task_id)
            activity(session,task,'roster_changed',actor,'Обновлены ответственные за заполнение ККР')
        candidates=session.query(TaskORM).filter_by(season_id=season_id,scope_kind=kind,scope_id=scope_id).all()
        for work in candidates:
            meta=session.query(TaskTrackerORM).filter_by(task_id=work.task_id).first()
            if work.task_id in control_ids or not meta or meta.task_type!='task' or public_status(meta.status)!='closed':continue
            link=session.query(TaskLinkORM).filter_by(source_task_id=task.task_id,target_task_id=work.task_id,kind='related').first()
            if link:continue
            session.add(TaskLinkORM(link_id='link-'+str(uuid.uuid4()),source_task_id=task.task_id,target_task_id=work.task_id,
                kind='related',created_by_user_id=actor,created_at=now()))
            for endpoint in (task,work):
                if endpoint.task_id not in touched:endpoint.revision+=1;touched.add(endpoint.task_id)
                activity(session,endpoint,'link_added',actor,'Связана задача контроля заполнения ККР')
    session.flush()


def close_for_season(session, season_id, actor_uid):
    from tracker import activity
    for control in session.query(KkrControlEpicORM).filter_by(season_id=season_id):
        task=session.get(TaskORM,control.task_id)
        meta=session.query(TaskTrackerORM).filter_by(task_id=control.task_id).first()
        if task and meta and meta.status!='closed':
            meta.status='closed';meta.closed_at=now();task.revision+=1
            activity(session,task,'status_changed',actor_uid,'Завершён сезонный контроль ККР',before='open',after='closed')


def projection(season_id, uid):
    if not access.allowed(uid,'summary.view'):raise Forbidden('Summary reader required')
    from tracker import public_status
    from task_queues import readable_tasks
    from sqlalchemy.orm import joinedload
    with db._session() as session:
        if not session.get(SeasonORM,season_id):raise NotFound('Season not found')
        controls=session.query(KkrControlEpicORM).filter_by(season_id=season_id).all()
        control_ids=[row.task_id for row in controls]
        links=defaultdict(list)
        if control_ids:
            for link in session.query(TaskLinkORM).filter(TaskLinkORM.source_task_id.in_(control_ids),TaskLinkORM.kind=='related'):
                links[link.source_task_id].append(link.target_task_id)
        task_ids=set(control_ids)|{tid for targets in links.values() for tid in targets}
        tasks={row.task_id:row for row in session.query(TaskORM).filter(TaskORM.task_id.in_(task_ids))} if task_ids else {}
        visible={row.task_id for row in readable_tasks(session,tasks.values(),uid)}
        metas={row.task_id:row for row in session.query(TaskTrackerORM).filter(TaskTrackerORM.task_id.in_(task_ids))} if task_ids else {}
        assignments=defaultdict(list);roster=defaultdict(list);user_ids=set()
        if task_ids:
            for row in session.query(AssignmentORM).filter(AssignmentORM.task_id.in_(task_ids)):
                assignments[row.task_id].append(row);user_ids.add(row.assignee_user_id)
        if control_ids:
            for row in session.query(TaskRosterORM).filter(TaskRosterORM.task_id.in_(control_ids),TaskRosterORM.role=='assignee'):
                roster[row.task_id].append(row);user_ids.add(row.user_id)
        refs={row.user_id:asdict(_user_to_ref_dc(row)) for row in session.query(UserORM).options(joinedload(UserORM.contact)).filter(UserORM.user_id.in_(user_ids))} if user_ids else {}
        queue_ids={row.queue_id for row in metas.values() if row.queue_id}
        queues={row.queue_id:row for row in session.query(TaskQueueORM).filter(TaskQueueORM.queue_id.in_(queue_ids))} if queue_ids else {}
        block_names={row.block_id:row.legacy_name for row in session.query(BlockMetaORM)}
        result=[]
        for control in controls:
            task=tasks.get(control.task_id)
            if not task or task.task_id not in visible:continue
            scope_id=block_names.get(control.source_id,control.source_id) if control.source_kind=='block' else control.source_id
            work=[]
            for task_id in links[task.task_id]:
                related=tasks.get(task_id);meta=metas.get(task_id)
                if (not related or related.season_id!=season_id or not meta or public_status(meta.status)!='closed'
                        or task_id not in visible or related.scope_kind!=control.source_kind or related.scope_id!=scope_id):continue
                missing=[row for row in assignments[task_id] if row.status!='cancelled' and (row.hours is None or row.evaluation is None)]
                if missing:
                    queue=queues.get(meta.queue_id)
                    work.append(dict(task_id=task_id,title=related.title,task_key=queue.key+'-'+str(meta.queue_number) if queue else None,
                        missing_assignees=[refs[row.assignee_user_id] for row in missing if row.assignee_user_id in refs]))
            meta=metas.get(task.task_id)
            result.append(dict(control_id=control.control_id,task_id=task.task_id,title=task.title,source_kind=control.source_kind,
                source_id=control.source_id,status=public_status(meta.status if meta else None),
                responsibles=[refs[row.user_id] for row in roster[task.task_id] if row.user_id in refs],missing_tasks=work,missing_count=len(work)))
        return dict(items=result,capabilities=['remind_kkr'] if access.HR_MASTER in access._global(uid) else [])


def remind(season_id, uid):
    if access.HR_MASTER not in access._global(uid):raise Forbidden('HR master required')
    with db.atomic():
      with db._session() as session:
        sync_for_season(session,season_id,uid)
        data=projection(season_id,uid);count=0
        from tracker_collaboration import add_mention_comment
        for item in data['items']:
            targets=[p['user_id'] for p in item['responsibles'] if p['user_id'] is not None]
            if item['missing_count'] and targets:
                add_mention_comment(session,session.get(TaskORM,item['task_id']),uid,
                    'Призываю заполнить ККР закрытых задач. Осталось задач: '+str(item['missing_count'])+'.',targets)
                count+=1
        return dict(comments_created=count)


def register_routes(router):
    from auth import get_current_user
    from kkr_control_hooks import finish_startup_recovery
    finish_startup_recovery()
    @router.get('/seasons/{season_id}/kkr-control')
    def controls(season_id:str,cur:User=Depends(get_current_user)):
        return projection(season_id,cur.user_id)
    @router.post('/seasons/{season_id}/kkr-control/remind')
    def remind_controls(season_id:str,cur:User=Depends(get_current_user)):
        return remind(season_id,cur.user_id)
