"""API 1.3 capability projection. The same domain predicates authorize commands."""
from contextvars import ContextVar
from database import db

actor_id=ContextVar('profkom_actor_id',default=None)


def global_caps(uid):
    if not uid: return []
    u=db.get_user(uid)
    if not u or u.account_state!='active' or u.banned: return []
    caps={'create_material'} if db.is_tachki(uid) or db.get_user_master_block_names(uid) or any(a.role=='deputy_master' for a in db.get_user_assignments(uid)) else set()
    if db.is_tachki(uid):
        caps.update(['create_event','review_registrations','create_chair_merit','correct_season','edit_former_contacts','manage_material_editors','edit_participant_category'])
    if db.is_tachki(uid) or db.is_hr_master(uid):
        caps.update(['view_kkr','view_summary','edit_former_contacts','edit_participant_category'])
    if db.is_chair(uid):
        caps.update(['transfer_chair','manage_chair_deputies','archive_account','restore_account','open_season','close_season'])
    return sorted(caps)


def season_caps(season, uid=None):
    uid=uid or actor_id.get()
    caps=set()
    if db.is_chair(uid):
        caps.update({'planned':['open_season','edit_season'],'open':['edit_season','begin_summary'],'summarizing':['close_season']}.get(season.state,[]))
    if db.is_tachki(uid) and season.state in ('planned','open'): caps.add('create_event')
    if db.is_tachki(uid) or db.is_hr_master(uid): caps.add('view_summary')
    return sorted(caps)


def event_caps(event, uid=None):
    uid=uid or actor_id.get();s=db.get_season(event.season_id)
    if not s or s.state=='closed':return []
    own=db.is_event_leader(uid,event.event_id) or db.is_event_leader_deputy(uid,event.event_id)
    caps=set()
    if db.is_tachki(uid) or own:
        caps.update(['edit_event','manage_organizers','edit_meeting','delete_meeting','create_head_merit'])
        if s.state in ('planned','open'):caps.add('create_subevent')
    if db.is_tachki(uid):caps.update(['manage_leaders','manage_deputies'])
    if own:caps.add('create_report')
    return sorted(caps)


def subevent_caps(sub, uid=None):
    uid=uid or actor_id.get();event=db.get_event(sub.event_id);s=db.get_season(event.season_id)
    if s.state=='closed':return []
    caps=set()
    own=db.is_subevent_leader(uid,sub.subevent_id) or db.is_subevent_leader_deputy(uid,sub.subevent_id)
    parent=db.is_event_leader(uid,sub.event_id) or db.is_event_leader_deputy(uid,sub.event_id)
    if db.is_tachki(uid) or parent:caps.update(['manage_leaders','manage_deputies','manage_organizers','edit_subevent'])
    if own or parent or db.is_tachki(uid):
        caps.update(['edit_meeting','delete_meeting','view_assessment_inputs','edit_assessment_inputs','create_volunteer_merit','view_unresolved_assignments'])
        if s.state in ('planned','open'):caps.add('create_task')
    if own:caps.add('create_report')
    return sorted(caps)


def leader_caps(leader,uid=None):
    uid=uid or actor_id.get()
    with db._session() as session:
        from database import RoleAssignmentORM
        a=session.get(RoleAssignmentORM,leader.role_assignment_id)
        if not a:return []
        if db.is_tachki(uid):return ['manage_deputies']
        if a.scope_kind=='block' and a.user_id==uid:return ['manage_deputies']
        if a.scope_kind=='subevent':
            sub=db.get_subevent(a.scope_id)
            if sub and (db.is_event_leader(uid,sub.event_id) or db.is_event_leader_deputy(uid,sub.event_id)):return ['manage_deputies']
    return []


def scope_inputs(uid,kind,scope_id,season_id,write=False):
    season=db.get_season(season_id)
    if write and season and season.state=='closed':return db.is_chair(uid)
    return bool(db.can_manage_scope(uid,kind,scope_id) or db.is_hr_master(uid))
