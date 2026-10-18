"""An administrative season correction moves the complete hierarchy atomically."""
import uuid
from database import db,SeasonORM,EventORM,SubeventORM,TaskORM,MeritORM,ReportORM,AssignmentORM,ContributionORM,SeasonCorrectionORM
from models import SeasonCorrectionResult
from participation import dt
from registration import now,audit
from season_summaries import refresh


def correct(kind,id,revision,target_id,reason,uid):
    if not db.is_tachki(uid):raise ValueError('Forbidden: only tachki can correct season')
    if not reason or not reason.strip():raise ValueError('Reason is required')
    with db.atomic():
        with db._session() as s:
            target=s.get(SeasonORM,target_id)
            if not target:raise LookupError('Target season not found')
            if target.state=='closed':raise ValueError('Conflict: target season is closed')
            tasks=[];merits=[];reports=[]
            if kind=='event':
                obj=s.get(EventORM,id)
                if not obj:raise LookupError('Event not found')
                subs=[r.subevent_id for r in s.query(SubeventORM).filter_by(event_id=id)]
                tasks=s.query(TaskORM).filter(TaskORM.scope_kind=='subevent',TaskORM.scope_id.in_(subs)).all()
                merits=s.query(MeritORM).filter((MeritORM.event_id==id)|((MeritORM.scope_kind=='subevent') & MeritORM.scope_id.in_(subs))).all()
                reports=s.query(ReportORM).filter(((ReportORM.owner_kind=='event')&(ReportORM.owner_id==id))|((ReportORM.owner_kind=='subevent')&ReportORM.owner_id.in_(subs))).all()
                if obj.ends_at and dt(obj.ends_at)>dt(target.ends_at):raise ValueError('Event deadline exceeds target season')
            elif kind=='block_task':
                obj=s.get(TaskORM,id)
                if not obj or obj.scope_kind!='block':raise LookupError('Block task not found')
                tasks=[obj]
            elif kind=='merit':
                obj=s.get(MeritORM,id)
                if not obj:raise LookupError('Merit not found')
                if obj.source_kind not in ('chair_merit','block_volunteer'):raise ValueError('Only independent merits can move separately')
                merits=[obj]
            else:raise ValueError('Invalid correction object kind')
            if obj.revision!=revision:raise ValueError('Conflict: revision mismatch')
            source_id=obj.season_id;source=s.get(SeasonORM,source_id)
            if source_id==target_id:raise ValueError('Source and target must differ')
            if not source or source.state=='closed':raise ValueError('Conflict: source season is closed')
            if kind!='event' and target.state=='planned':raise ValueError('Only event hierarchy can move to a planned season')
            for item in [*tasks,*merits]:
                if item.season_id!=source_id:raise ValueError('Conflict: inconsistent hierarchy season')
                if dt(item.deadline_at)>dt(target.ends_at):raise ValueError('Child deadline exceeds target season')
            if any(r.season_id!=source_id for r in reports):raise ValueError('Conflict: inconsistent report season')
            if kind=='event':obj.season_id=target_id;obj.revision+=1
            for item in [*tasks,*merits]:item.season_id=target_id;item.revision+=1
            for report in reports:report.season_id=target_id;report.revision+=1
            aids=[a.assignment_id for a in s.query(AssignmentORM).filter(AssignmentORM.task_id.in_([t.task_id for t in tasks]))]
            mids=[m.merit_id for m in merits]
            s.query(ContributionORM).filter((ContributionORM.assignment_id.in_(aids))|(ContributionORM.merit_id.in_(mids))).update({'season_id':target_id},synchronize_session=False)
            s.add(SeasonCorrectionORM(correction_id=str(uuid.uuid4()),object_kind=kind,object_id=id,source_season_id=source_id,target_season_id=target_id,changed_by_user_id=uid,reason=reason,created_at=now()))
            audit(s,kind,id,uid,reason,dict(season_id=source_id),dict(season_id=target_id))
            refresh(s,source_id,uid,reason);refresh(s,target_id,uid,reason);s.commit()
            return SeasonCorrectionResult(object_kind=kind,object_id=id,source_season_id=source_id,target_season_id=target_id,revision=obj.revision)
