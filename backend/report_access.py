"""Report editors are frozen per instance; historical readers are scoped by series."""
from database import db,UserORM,SeasonORM,EventORM,SubeventORM,RoleAssignmentORM,ReportSeriesORM,ReportEditorORM,ReportORM
from registration import now


def active(s,uid):
    user=s.get(UserORM,uid)
    return bool(user and user.account_state=='active' and not user.banned)

def editor(s,r,uid):
    if not active(s,uid):return False
    if s.get(SeasonORM,r.season_id).state=='closed':
        return s.query(ReportEditorORM).filter(ReportEditorORM.season_id==r.season_id,ReportEditorORM.user_id==uid,((ReportEditorORM.owner_kind==r.owner_kind)&(ReportEditorORM.owner_id==r.owner_id))|(ReportEditorORM.report_id==r.report_id)).first() is not None
    if r.owner_kind=='event':return db.is_event_leader(uid,r.owner_id) or db.is_event_leader_deputy(uid,r.owner_id)
    return db.is_subevent_leader(uid,r.owner_id) or db.is_subevent_leader_deputy(uid,r.owner_id)

def historical_reader(s,series_id,uid):
    if not active(s,uid):return False
    if db.is_tachki(uid):return True
    series=s.get(ReportSeriesORM,series_id)
    if not series:return False
    for ev in s.query(EventORM).join(SeasonORM).filter(SeasonORM.state!='closed'):
        if (db.is_event_leader(uid,ev.event_id) or db.is_event_leader_deputy(uid,ev.event_id)) and series_id in (ev.report_series_id,) :return True
        if (db.is_event_leader(uid,ev.event_id) or db.is_event_leader_deputy(uid,ev.event_id)) and series.parent_series_id==ev.report_series_id:return True
    for sub in s.query(SubeventORM).join(EventORM).join(SeasonORM).filter(SeasonORM.state!='closed',SubeventORM.report_series_id==series_id):
        if db.is_subevent_leader(uid,sub.subevent_id) or db.is_subevent_leader_deputy(uid,sub.subevent_id):return True
    return False

def reader(s,r,uid):
    if not active(s,uid):return False
    if editor(s,r,uid):return True
    if r.state!='published':return False
    if db.is_tachki(uid):return True
    if s.get(SeasonORM,r.season_id).state=='closed':return historical_reader(s,r.report_series_id,uid)
    if r.owner_kind=='event':return db.is_event_leader(uid,r.owner_id) or db.is_event_leader_deputy(uid,r.owner_id)
    sub=s.get(SubeventORM,r.owner_id)
    return bool(sub and (db.is_subevent_leader(uid,sub.subevent_id) or db.is_subevent_leader_deputy(uid,sub.subevent_id) or db.is_subevent_organizer(uid,sub.subevent_id) or db.is_event_leader(uid,sub.event_id) or db.is_event_leader_deputy(uid,sub.event_id)))


def freeze_editors(s,season_id):
    owners=[('event',e.event_id) for e in s.query(EventORM).filter_by(season_id=season_id)]
    owners += [('subevent',sub.subevent_id) for sub in s.query(SubeventORM).join(EventORM).filter(EventORM.season_id==season_id)]
    for kind,id in owners:
        for assignment in s.query(RoleAssignmentORM).filter_by(scope_kind=kind,scope_id=id):
            if active(s,assignment.user_id):s.add(ReportEditorORM(season_id=season_id,owner_kind=kind,owner_id=id,report_id=None,user_id=assignment.user_id,role=assignment.role,created_at=now()))
    for report in s.query(ReportORM).filter_by(season_id=season_id):
        if editor(s,report,report.created_by_user_id):s.add(ReportEditorORM(season_id=season_id,owner_kind=report.owner_kind,owner_id=report.owner_id,report_id=report.report_id,user_id=report.created_by_user_id,role='author',created_at=now()))
