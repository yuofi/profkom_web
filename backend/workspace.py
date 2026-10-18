"""Permission-filtered API 1.3 workspace projections."""
import json
from datetime import datetime, timezone
from dataclasses import asdict
from database import db, TaskORM, AssignmentORM, EventORM, SubeventORM, MeetingORM, SeasonORM, NotificationORM


def live(season_id):
    s=db.get_season(season_id)
    return bool(s and s.state!='closed')


def meeting_read(uid,m):
    if m.owner_kind=='subevent':return db.can_view_scope(uid,'subevent',m.owner_id)
    if db.is_tachki(uid) or db.is_event_leader(uid,m.owner_id) or db.is_event_leader_deputy(uid,m.owner_id):return True
    return any(db.is_subevent_leader(uid,s.subevent_id) or db.is_subevent_leader_deputy(uid,s.subevent_id) for s in db.list_subevents(m.owner_id))


def meeting_dict(uid,m):
    own=(db.is_event_leader(uid,m.owner_id) or db.is_event_leader_deputy(uid,m.owner_id)) if m.owner_kind=='event' else (db.is_subevent_leader(uid,m.owner_id) or db.is_subevent_leader_deputy(uid,m.owner_id))
    return dict(meeting_id=m.meeting_id,owner_kind=m.owner_kind,owner_id=m.owner_id,title=m.title,starts_at=m.starts_at,join_url=m.join_url,revision=m.revision,capabilities=['edit_meeting','delete_meeting'] if own or db.is_tachki(uid) else [])


def notifications(uid):
    result=[]
    with db._session() as s:
        for n in s.query(NotificationORM).filter_by(user_id=uid).order_by(NotificationORM.created_at.desc()).all():
            p=json.loads(n.payload_json or '{}');target=None;allowed=True
            if p.get('task_id'):
                t=s.get(TaskORM,p['task_id']);allowed=bool(t and db.can_view_scope(uid,t.scope_kind,t.scope_id));target={'kind':'task','id':p['task_id']}
            elif p.get('subevent_id'):
                allowed=db.can_view_scope(uid,'subevent',p['subevent_id']);target={'kind':'subevent','id':p['subevent_id']}
            elif p.get('event_id'):
                e=s.get(EventORM,p['event_id']);allowed=bool(e);target={'kind':'event','id':p['event_id']}
            elif p.get('scope_kind') in ('block','subevent'):
                allowed=db.can_view_scope(uid,p['scope_kind'],p.get('scope_id'));target={'kind':p['scope_kind'],'id':p.get('scope_id')}
            result.append(dict(id=n.notification_id,kind=n.kind if allowed else 'access_revoked',text=(p.get('title') or {'task_assignment':'Вам назначена задача','task_help_required':'Требуется помощь','block_left':'Участник вышел из блока'}.get(n.kind,'Изменение рабочего объекта')) if allowed else 'Доступ к объекту завершён',created_at=n.created_at,read_at=n.created_at if n.is_read else None,target=target if allowed else None))
    return result


def dashboard(uid):
    import main
    with db._session() as s:
        tasks=[t for t in db.list_tasks(current_user_id=uid,mine_user_id=uid) if live(t.season_id) and any(a.assignee.user_id==uid and a.status in ('assigned','in_progress','help_required','submitted','needs_revision') for a in t.assignments)]
        meetings=[]
        now=datetime.now(timezone.utc).isoformat()
        for m in s.query(MeetingORM).all():
            ev=s.get(EventORM,m.owner_id) if m.owner_kind=='event' else s.get(EventORM,s.get(SubeventORM,m.owner_id).event_id)
            if live(ev.season_id) and m.starts_at>=now and meeting_read(uid,m):meetings.append(meeting_dict(uid,m))
        events=[]
        for e in db.list_events():
            if live(e.season_id) and (db.is_event_leader(uid,e.event_id) or db.is_event_leader_deputy(uid,e.event_id) or any(db.can_view_scope(uid,'subevent',sub.subevent_id) for sub in db.list_subevents(e.event_id))):events.append(main._to_event_out(e))
        try:
            from membership import blocks_for, requests_for
            blocks=[b for b in blocks_for(uid) if 'view_tasks' in b['capabilities']]
            requests=[r for r in requests_for(uid) if any(c in r['capabilities'] for c in ('hr_review_request','block_review_request'))]
        except ImportError:
            blocks=[];requests=[]
        unresolved=[dict(assignment=asdict(u.assignment),task_id=u.task_id,task_title=u.task_title,season_id=u.season_id,scope=__import__('membership').scope_out(u.scope),deadline_at=u.deadline_at) for u in db.list_unresolved_assignments(current_user_id=uid) if live(u.season_id)]
        return dict(my_tasks=[main._to_task_public_out(t) for t in tasks],upcoming_meetings=sorted(meetings,key=lambda m:m['starts_at']),my_blocks=blocks,my_events=events,actionable_requests=requests,unresolved_assignments=unresolved,unread_notification_count=sum(n['read_at'] is None for n in notifications(uid)))


def calendar(uid,start,end):
    result=[]
    with db._session() as s:
        for t in db.list_tasks(current_user_id=uid,mine_user_id=uid):
            if live(t.season_id) and start<=t.deadline_at<=end:
                result.append(dict(id='task-'+t.task_id,season_id=t.season_id,kind='task_deadline',title=t.title,starts_at=t.deadline_at,ends_at=None,target=dict(kind='task',id=t.task_id)))
        for m in s.query(MeetingORM).all():
            ev=s.get(EventORM,m.owner_id) if m.owner_kind=='event' else s.get(EventORM,s.get(SubeventORM,m.owner_id).event_id)
            if live(ev.season_id) and start<=m.starts_at<=end and meeting_read(uid,m):result.append(dict(id='meeting-'+m.meeting_id,season_id=ev.season_id,kind='meeting',title=m.title,starts_at=m.starts_at,ends_at=None,target=dict(kind=m.owner_kind,id=m.owner_id)))
        for e in db.list_events():
            if live(e.season_id) and e.starts_at and start<=e.starts_at<=end and (db.is_tachki(uid) or db.is_event_leader(uid,e.event_id) or db.is_event_leader_deputy(uid,e.event_id) or any(db.can_view_scope(uid,'subevent',sub.subevent_id) for sub in db.list_subevents(e.event_id))):result.append(dict(id='event-'+e.event_id,season_id=e.season_id,kind='event',title=e.title,starts_at=e.starts_at,ends_at=e.ends_at,target=dict(kind='event',id=e.event_id)))
    return sorted(result,key=lambda v:v['starts_at'])
