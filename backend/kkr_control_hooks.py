"""Reconcile control tickets at real write commits, never while serving a GET."""
import sys
from sqlalchemy import event, inspect
from sqlalchemy.orm import Session
from database import (db, _active_session, SeasonORM, BlockORM, EventORM, SubeventORM,
    LeadershipORM, RoleAssignmentORM, UserORM, TaskORM, TaskTrackerORM, TaskQueueORM)
from domain_models import BlockMetaORM
from event_workspace_models import EventWorkspaceMetaORM

_RUNNING='kkr_control_reconciling'
_MARKER='kkr_control_needed'
_CLOSING='kkr_control_closing'
_CLOSED_TASKS='kkr_control_closed_tasks'
_PENDING=False
_RELEVANT={
    SeasonORM:('state',),TaskORM:('season_id','scope_kind','scope_id'),BlockORM:('name','master_user_id','is_hr'),BlockMetaORM:('hr_user_id','legacy_name','block_id'),
    EventORM:('season_id','title'),SubeventORM:('event_id','title'),
    LeadershipORM:('chair_user_id','deputies_json'),RoleAssignmentORM:('role','user_id','scope_kind','scope_id'),
    UserORM:('account_state','banned'),TaskTrackerORM:('status',),
    TaskQueueORM:('scope_kind','scope_id'),EventWorkspaceMetaORM:('hr_user_id',),
}


def reconcile(session, actor_uid=None):
    if session.info.get(_RUNNING):return 0
    session.info[_RUNNING]=True
    token=_active_session.set(session) if _active_session.get() is None else None
    try:
        from kkr_control import sync_for_season,close_for_season
        session.flush()
        closing=set(session.info.get(_CLOSING,()))
        for sid in closing:
            season=session.get(SeasonORM,sid)
            if season and season.state=='closed':close_for_season(session,sid,actor_uid)
        synced=session.info.get('kkr_control_synced_seasons',set())
        seasons=session.query(SeasonORM).filter(SeasonORM.state.in_(['open','summarizing'])).all()
        for season in seasons:
            if season.season_id not in synced:sync_for_season(session,season.season_id,actor_uid)
        session.flush()
        return len(seasons)
    finally:
        if token is not None:_active_session.reset(token)
        session.info.pop(_RUNNING,None);session.info.pop(_MARKER,None);session.info.pop(_CLOSING,None)
        session.info.pop(_CLOSED_TASKS,None)


def _material_role(obj):
    """A material editor or a site grant (before and after the change): no control reads it."""
    if not isinstance(obj,RoleAssignmentORM):return False
    history=inspect(obj).attrs['scope_kind'].history
    return all(kind in ('material','site') for kind in (*history.deleted,*history.added,*history.unchanged))


def _holds_role(session, user):
    """Chair, a block master or any stored role: only such accounts are in a control
    roster, its owner or a sync's assignees and watchers."""
    uid=user.user_id
    if uid is None:return False  # a new account has no stored role yet
    leadership=session.get(LeadershipORM,1)
    if leadership is not None and leadership.chair_user_id==uid:return True
    if session.query(BlockORM.name).filter(BlockORM.master_user_id==uid).first():return True
    return session.query(RoleAssignmentORM.role_assignment_id).filter(RoleAssignmentORM.user_id==uid).first() is not None


def reconcile_existing():
    global _PENDING
    policy=sys.modules.get('access')
    auth_module=sys.modules.get('auth')
    if (policy is not None and not getattr(policy,'_QUEUE_OWNER_RECOVERY_READY',False)) or (auth_module is not None and not hasattr(auth_module,'get_current_user')):
        _PENDING=True;return 0
    with db.atomic():
      with db._session() as lease:
        result=reconcile(getattr(lease,'session',lease))
    _PENDING=False
    return result


def finish_startup_recovery():
    return reconcile_existing() if _PENDING else 0


def install_hooks():
    if getattr(install_hooks,'installed',False):return
    install_hooks.installed=True
    @event.listens_for(Session,'before_flush')
    def track(session,_context,_instances):
        if session.info.get(_RUNNING):return
        changed=[];titles=False;closed=[]
        for obj in (*session.new,*session.deleted):
            if isinstance(obj,TaskORM) and obj in session.new:continue
            if isinstance(obj,TaskTrackerORM):
                from tracker_status import public_status
                if public_status(obj.status)!='closed':continue
            if type(obj) in _RELEVANT and not _material_role(obj):changed.append(obj)
        for obj in session.dirty:
            if isinstance(obj,TaskTrackerORM):
                from tracker_status import public_status
                if public_status(obj.status)!='closed':continue
                # A task's closing only adds its link to the control epic (at commit).
                if inspect(obj).attrs['status'].history.has_changes():closed.append(obj.task_id)
                continue
            fields=_RELEVANT.get(type(obj))
            moved=[name for name in fields if inspect(obj).attrs[name].history.has_changes()] if fields else []
            if not moved or _material_role(obj):continue
            # Titles only reach the season summary's source names; controls keep theirs.
            if isinstance(obj,(EventORM,SubeventORM)) and moved==['title']:titles=True;continue
            changed.append(obj)
        # Accounts without a role, mastership or chairmanship are in no control roster.
        changed=[obj for obj in changed if not isinstance(obj,UserORM) or _holds_role(session,obj)]
        if titles:session.info.pop("season_source_title_cache",None)
        if closed:session.info.setdefault(_CLOSED_TASKS,set()).update(closed)
        if not changed:return
        if any(isinstance(obj,(BlockORM,BlockMetaORM)) for obj in changed):
            session.info.pop("season_coefficient_block_ids",None)
        session.info[_MARKER]=True
        session.info.pop("season_source_title_cache",None)
        session.info.pop('kkr_control_synced_seasons',None)
        for obj in changed:
            if isinstance(obj,SeasonORM) and obj.state=='closed':
                session.info.setdefault(_CLOSING,set()).add(obj.season_id)
    @event.listens_for(Session,'do_orm_execute')
    def bulk(state):
        if state.session.info.get(_RUNNING) or not (state.is_update or state.is_delete):return
        table=getattr(state.statement,'table',None)
        if table is not None and table.name in {model.__tablename__ for model in _RELEVANT}:
            state.session.info[_MARKER]=True;state.session.info.pop('kkr_control_synced_seasons',None)
            state.session.info.pop('season_source_title_cache',None)
            if table.name in {'block','block_metadata'}:state.session.info.pop('season_coefficient_block_ids',None)
    @event.listens_for(Session,'before_commit')
    def final(session):
        if session.info.get(_RUNNING) or session.info.get('profkom_read_context') is not None:return
        session.flush()
        import access
        actor=access.actor_id.get() or session.info.get('tracker_actor')
        if session.info.get(_MARKER):
            reconcile(session,actor)
        elif session.info.get(_CLOSED_TASKS):
            from kkr_control import link_closed
            closed=sorted(session.info.pop(_CLOSED_TASKS))
            if not link_closed(session,closed,actor):
                reconcile(session,actor)
    @event.listens_for(Session,'after_commit')
    @event.listens_for(Session,'after_rollback')
    def clear(session):
        for key in (_MARKER,_CLOSING,_CLOSED_TASKS,'kkr_control_synced_seasons','season_coefficient_block_ids','season_coefficient_read_cache','season_source_title_cache'):session.info.pop(key,None)
