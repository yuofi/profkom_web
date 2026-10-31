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


def _roles(session, role, kind, sid, reads=None):
    if reads is not None and reads.batched:
        return {uid for uid in reads.role_holders(role, kind, sid) if _active(session, uid)}
    return {r.user_id for r in session.query(RoleAssignmentORM).filter_by(role=role, scope_kind=kind, scope_id=sid)
            if _active(session, r.user_id)}


def _hr(session, reads=None):
    blocks = session.query(BlockORM).filter_by(is_hr=True).all()
    masters = {b.master_user_id for b in blocks if _active(session, b.master_user_id)}
    deputies = set()
    for block in blocks:
        deputies |= _roles(session, 'deputy_master', 'block', block.name, reads)
    return masters, deputies


# Rows a season sync reads per scope. With no modified row of these kinds in the
# session (reconcile flushes first) they are read once per sync instead.
_SYNC_ROWS = None


class _Reads:
    """The lookups of one season sync: one query per kind of row, or the original
    per-scope queries when the session holds modified rows they would not reflect.

    Unflushed new rows are invisible to both (sessions never autoflush). Controls
    created during the sync keep the original lookups for their roster and grants.
    """
    def __init__(self, session, season_id):
        from tracker_collaboration_models import TaskAccessGrantORM
        global _SYNC_ROWS
        if _SYNC_ROWS is None:
            _SYNC_ROWS = (RoleAssignmentORM, BlockMetaORM, SubeventORM, TaskORM, TaskTrackerORM, TaskLinkORM,
                          TaskRosterORM, TaskAccessGrantORM, KkrControlEpicORM)
        self.session, self.season_id, self.fresh = session, season_id, set()
        self.batched = not any(isinstance(row, _SYNC_ROWS) for row in (*session.dirty, *session.deleted))
        if not self.batched:
            return
        self.roles = defaultdict(set)
        for user_id, role, kind, sid in session.query(RoleAssignmentORM.user_id, RoleAssignmentORM.role,
                RoleAssignmentORM.scope_kind, RoleAssignmentORM.scope_id).filter(
                RoleAssignmentORM.role.in_(['deputy_master', access.EVENT_LEADER, 'subevent_leader'])):
            self.roles[role, kind, sid].add(user_id)
        self.metas = {}
        for meta in session.query(BlockMetaORM):
            self.metas.setdefault(meta.legacy_name, meta)
        self.controls = {}
        for control in session.query(KkrControlEpicORM).filter_by(season_id=season_id):
            self.controls.setdefault((control.source_kind, control.source_id), control)
        known = [control.task_id for control in self.controls.values()]
        self.members, self.grants, self.links = {}, {}, set()
        for start in range(0, len(known), 400):
            batch = known[start:start + 400]
            self.members.update(((row.task_id, row.user_id), row) for row in
                                session.query(TaskRosterORM).filter(TaskRosterORM.task_id.in_(batch)))
            self.grants.update(((row.task_id, row.user_id), row) for row in
                               session.query(TaskAccessGrantORM).filter(TaskAccessGrantORM.task_id.in_(batch)))
            self.links.update((source, target) for source, target in session.query(
                TaskLinkORM.source_task_id, TaskLinkORM.target_task_id).filter(
                TaskLinkORM.source_task_id.in_(batch), TaskLinkORM.kind == 'related'))
        self.tasks = defaultdict(list)
        for task in session.query(TaskORM).filter_by(season_id=season_id):
            self.tasks[task.scope_kind, task.scope_id].append(task)
        ids = [task.task_id for rows in self.tasks.values() for task in rows]
        self.trackers = {}
        for start in range(0, len(ids), 400):
            for row in session.query(TaskTrackerORM).filter(TaskTrackerORM.task_id.in_(ids[start:start + 400])):
                self.trackers.setdefault(row.task_id, row)
        self.events = session.query(EventORM).filter_by(season_id=season_id).all()
        self.subevents = defaultdict(list)
        event_ids = [event.event_id for event in self.events]
        for start in range(0, len(event_ids), 400):
            for sub in session.query(SubeventORM).filter(SubeventORM.event_id.in_(event_ids[start:start + 400])):
                self.subevents[sub.event_id].append(sub)

    def role_holders(self, role, kind, sid):
        return self.roles.get((role, kind, sid), ())

    def block_meta(self, name):
        if self.batched:
            return self.metas.get(name)
        return self.session.query(BlockMetaORM).filter_by(legacy_name=name).first()

    def season_events(self):
        return self.events if self.batched else self.session.query(EventORM).filter_by(season_id=self.season_id)

    def event_subevents(self, event_id):
        return self.subevents.get(event_id, []) if self.batched else self.session.query(SubeventORM).filter_by(event_id=event_id)

    def control(self, kind, identity):
        if self.batched:
            return self.controls.get((kind, identity))
        return self.session.query(KkrControlEpicORM).filter_by(season_id=self.season_id, source_kind=kind, source_id=identity).first()

    def created(self, task_id):
        self.fresh.add(task_id)

    def member(self, task_id, uid):
        if self.batched and task_id not in self.fresh:
            return self.members.get((task_id, uid))
        return self.session.get(TaskRosterORM, (task_id, uid))

    def grant(self, task_id, uid):
        from tracker_collaboration_models import TaskAccessGrantORM
        if self.batched and task_id not in self.fresh:
            return self.grants.get((task_id, uid))
        return self.session.get(TaskAccessGrantORM, (task_id, uid))

    def candidates(self, kind, scope_id):
        if self.batched:
            return list(self.tasks.get((kind, scope_id), ()))
        return self.session.query(TaskORM).filter_by(season_id=self.season_id, scope_kind=kind, scope_id=scope_id).all()

    def tracker(self, task_id):
        if self.batched:
            return self.trackers.get(task_id)
        return self.session.query(TaskTrackerORM).filter_by(task_id=task_id).first()

    def linked(self, source, target):
        if self.batched and source not in self.fresh:
            return (source, target) in self.links
        return self.session.query(TaskLinkORM).filter_by(source_task_id=source, target_task_id=target, kind='related').first() is not None


def _scopes(session, season_id, reads=None):
    reads = reads if reads is not None else _Reads(session, season_id)
    leadership = session.get(LeadershipORM, 1)
    chair = leadership.chair_user_id if leadership and _active(session, leadership.chair_user_id) else None
    for block in session.query(BlockORM):
        meta = reads.block_meta(block.name)
        if meta:
            yield 'block', meta.block_id, block.name, block.name, {block.master_user_id} if _active(session, block.master_user_id) else set(), set()
    for event in reads.season_events():
        heads = _roles(session, access.EVENT_LEADER, 'event', event.event_id, reads)
        yield 'event', event.event_id, event.title, event.event_id, heads, set()
        for sub in reads.event_subevents(event.event_id):
            leaders = _roles(session, 'subevent_leader', 'subevent', sub.subevent_id, reads)
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
    reads = _Reads(session, season_id)
    masters, deputies = _hr(session, reads)
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
    for kind, identity, title, scope_id, assignees, extra_watchers in _scopes(session, season_id, reads):
        control = reads.control(kind, identity)
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
            session.add(control);session.flush();control_ids.add(task_id);reads.created(task_id)
            touched.add(task_id)
            activity(session,task,'created',actor,'Создан сезонный контроль ККР')
        task=session.get(TaskORM,control.task_id)
        old=json.loads(control.managed_json or '{}')
        desired={uid:'watcher' for uid in masters|deputies|extra_watchers}
        desired.update({uid:'assignee' for uid in assignees})
        changed=False
        for uid in set(old.get('users',[]))|set(desired):
            member=reads.member(task.task_id,int(uid))
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
                existing_grant=reads.grant(task.task_id,int(uid))
                if not existing_grant or not existing_grant.active:
                    grant_task_access(session,task.task_id,int(uid),actor,source='control')
        control.managed_json=json.dumps(dict(users=sorted(desired)))
        if changed:
            if task.task_id not in touched:task.revision+=1;touched.add(task.task_id)
            activity(session,task,'roster_changed',actor,'Обновлены ответственные за заполнение ККР')
        candidates=reads.candidates(kind,scope_id)
        for work in candidates:
            meta=reads.tracker(work.task_id)
            if work.task_id in control_ids or not meta or meta.task_type!='task' or public_status(meta.status)!='closed':continue
            if reads.linked(task.task_id,work.task_id):continue
            session.add(TaskLinkORM(link_id='link-'+str(uuid.uuid4()),source_task_id=task.task_id,target_task_id=work.task_id,
                kind='related',created_by_user_id=actor,created_at=now()))
            for endpoint in (task,work):
                if endpoint.task_id not in touched:endpoint.revision+=1;touched.add(endpoint.task_id)
                activity(session,endpoint,'link_added',actor,'Связана задача контроля заполнения ККР')
    session.flush()


def link_closed(session, task_ids, actor_uid=None, touched=()):
    """Link closed tasks to their scope's control epic, as a season sync would.

    For reconciled controls a task's closing changes nothing else a sync decides
    (rosters, grants, queue), so only this task's link is made. Returns False,
    before writing anything, when a full sync is needed instead: no owner queue or
    control for the scope yet, or a queue that no longer matches the sync's owner
    and privacy.
    """
    from tracker import activity, public_status
    plan=[]
    control_ids=None
    for task_id in dict.fromkeys(task_ids):
        work=session.get(TaskORM,task_id)
        if not work or not work.season_id:continue
        season=session.get(SeasonORM,work.season_id)
        if not season or season.state not in {'open','summarizing'}:continue
        masters,_=_hr(session)
        leadership=session.get(LeadershipORM,1)
        owner=next(iter(sorted(masters)),None) or (leadership.chair_user_id if leadership and _active(session,leadership.chair_user_id) else None)
        if not owner:continue  # the sync makes no control without an owner
        queue=session.query(TaskQueueORM).filter_by(key='KKR').first()
        if queue is None:return False
        if not session.query(KkrControlEpicORM).filter_by(queue_id=queue.queue_id).first():
            raise Conflict('The reserved KKR key belongs to an existing user queue; resolve the collision explicitly','control_queue_conflict')
        if not queue.is_private or queue.owner_user_id!=owner:return False
        kind,scope_id=work.scope_kind,work.scope_id
        if kind=='block':
            block=session.get(BlockORM,scope_id)
            meta=session.query(BlockMetaORM).filter_by(legacy_name=block.name).first() if block else None
            if not meta:continue  # no control for a block without metadata
            identity=meta.block_id
        elif kind=='event':
            event=session.get(EventORM,scope_id)
            if not event or event.season_id!=work.season_id:continue
            identity=scope_id
        elif kind=='subevent':
            sub=session.get(SubeventORM,scope_id)
            event=session.get(EventORM,sub.event_id) if sub else None
            if not event or event.season_id!=work.season_id:continue
            identity=scope_id
        elif kind=='chair' and scope_id=='chair':
            identity='chair'
        else:
            continue  # independent ('queue') tasks have no control
        control=session.query(KkrControlEpicORM).filter_by(season_id=work.season_id,source_kind=kind,source_id=identity).first()
        task=session.get(TaskORM,control.task_id) if control else None
        if task is None:return False
        if control_ids is None:control_ids={r.task_id for r in session.query(KkrControlEpicORM)}
        meta=session.query(TaskTrackerORM).filter_by(task_id=work.task_id).first()
        if work.task_id in control_ids or not meta or meta.task_type!='task' or public_status(meta.status)!='closed':continue
        if session.query(TaskLinkORM).filter_by(source_task_id=task.task_id,target_task_id=work.task_id,kind='related').first():continue
        plan.append((task,work,actor_uid if _active(session,actor_uid) else owner))
    marker='kkr_control_reconciling'
    was_running=session.info.get(marker)
    session.info[marker]=True
    try:
        touched=set(touched)
        for task,work,actor in plan:
            session.add(TaskLinkORM(link_id='link-'+str(uuid.uuid4()),source_task_id=task.task_id,target_task_id=work.task_id,
                kind='related',created_by_user_id=actor,created_at=now()))
            for endpoint in (task,work):
                if endpoint.task_id not in touched:endpoint.revision+=1;touched.add(endpoint.task_id)
                activity(session,endpoint,'link_added',actor,'Связана задача контроля заполнения ККР')
        session.flush()
        return True
    finally:
        if not was_running:session.info.pop(marker,None)


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
        return dict(items=result,capabilities=['remind_kkr'] if access.allowed(uid,'kkr.remind',state=access.season_state(season_id)) else [])


def remind(season_id, uid):
    state=access.season_state(season_id)
    if state is None:raise NotFound('Season not found')
    if not access.allowed(uid,'kkr.remind',state=state):
        raise Forbidden('HR master required' if state in {'open','summarizing'} else 'KKR reminders are sent only in an open or summarizing season')
    with db.atomic():
      with db._session() as session:
        sync_for_season(session,season_id,uid)
        data=projection(season_id,uid);count=0
        from tracker_collaboration import add_mention_comment
        for item in data['items']:
            targets=[p['user_id'] for p in item['responsibles'] if p['user_id'] is not None]
            if item['missing_count'] and targets:
                mentions=' '.join(f'[Участник {target}](/contacts/{target})' for target in targets)
                add_mention_comment(session,session.get(TaskORM,item['task_id']),uid,
                    mentions+'\n\nПризываю заполнить ККР закрытых задач. Осталось задач: '+str(item['missing_count'])+'.',targets)
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
