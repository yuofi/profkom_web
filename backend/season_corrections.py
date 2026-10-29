"""An administrative season correction moves the complete hierarchy atomically."""

from errors import Conflict, Forbidden, InvalidInput, NotFound, revision_conflict, season_closed
import uuid
from database import (
    db,
    SeasonORM,
    EventORM,
    SubeventORM,
    TaskORM,
    TaskTrackerORM,
    MeritORM,
    ReportORM,
    AssignmentORM,
    ContributionORM,
    SeasonCorrectionORM,
)
from models import SeasonCorrectionResult
from participation import dt
from registration import now, audit
from season_summaries import refresh


def preview_event(event_id, uid):
    import access
    if not access.allowed(uid, "season.correct"):
        raise Forbidden("Forbidden: season correction requires leadership access")
    with db._session() as session:
        event = session.get(EventORM, event_id)
        if not event:
            raise NotFound("Event not found")
        season = session.get(SeasonORM, event.season_id)
        if not season or season.state == "closed":
            raise season_closed("Conflict: source season is closed")
        subs = [row.subevent_id for row in session.query(SubeventORM).filter_by(event_id=event_id)]
        return dict(object_id=event_id, source_season_id=event.season_id, revision=event.revision,
            counts=dict(subevents=len(subs),
                tasks=session.query(TaskORM).filter(TaskORM.scope_kind == "subevent", TaskORM.scope_id.in_(subs)).count(),
                reports=session.query(ReportORM).filter(((ReportORM.owner_kind == "event") & (ReportORM.owner_id == event_id)) |
                    ((ReportORM.owner_kind == "subevent") & ReportORM.owner_id.in_(subs))).count(),
                merits=session.query(MeritORM).filter((MeritORM.event_id == event_id) |
                    ((MeritORM.scope_kind == "subevent") & MeritORM.scope_id.in_(subs))).count()))


def correct(kind, id, revision, target_id, reason, uid):
    import access

    if not access.allowed(uid, "season.correct"):
        raise Forbidden("Forbidden: only the chair and deputies can correct season")
    if not reason or not reason.strip():
        raise InvalidInput("Reason is required")
    with db.atomic():
        with db._session() as s:
            target = s.get(SeasonORM, target_id)
            if not target:
                raise NotFound("Target season not found")
            if target.state == "closed":
                raise season_closed("Conflict: target season is closed")
            tasks = []
            merits = []
            reports = []
            if kind == "event":
                obj = s.get(EventORM, id)
                if not obj:
                    raise NotFound("Event not found")
                subs = [
                    r.subevent_id for r in s.query(SubeventORM).filter_by(event_id=id)
                ]
                tasks = (
                    s.query(TaskORM)
                    .filter(
                        TaskORM.scope_kind == "subevent", TaskORM.scope_id.in_(subs)
                    )
                    .all()
                )
                merits = (
                    s.query(MeritORM)
                    .filter(
                        (MeritORM.event_id == id)
                        | (
                            (MeritORM.scope_kind == "subevent")
                            & MeritORM.scope_id.in_(subs)
                        )
                    )
                    .all()
                )
                reports = (
                    s.query(ReportORM)
                    .filter(
                        ((ReportORM.owner_kind == "event") & (ReportORM.owner_id == id))
                        | (
                            (ReportORM.owner_kind == "subevent")
                            & ReportORM.owner_id.in_(subs)
                        )
                    )
                    .all()
                )
                if obj.ends_at and dt(obj.ends_at) > dt(target.ends_at):
                    raise InvalidInput("Event deadline exceeds target season")
                if obj.starts_at and dt(obj.starts_at) > dt(target.ends_at):
                    raise InvalidInput("Event start exceeds target season")
            elif kind == "block_task":
                obj = s.get(TaskORM, id)
                if not obj or obj.scope_kind != "block":
                    raise NotFound("Block task not found")
                tasks = [obj]
            elif kind == "merit":
                obj = s.get(MeritORM, id)
                if not obj:
                    raise NotFound("Merit not found")
                if obj.source_kind not in ("chair_merit", "block_volunteer"):
                    raise InvalidInput("Only independent merits can move separately")
                merits = [obj]
            else:
                raise InvalidInput("Invalid correction object kind")
            for task in tasks:
                if not db.can_read_task(uid,task,s):raise Forbidden("Queue access is required for every moved task")
            # A correction moves a complete hierarchy. Parent links cannot silently cross seasons.
            moving={task.task_id for task in tasks}
            for meta in s.query(TaskTrackerORM).filter(TaskTrackerORM.parent_task_id.isnot(None)):
                if meta.task_id not in moving and meta.parent_task_id not in moving:continue
                child=s.get(TaskORM,meta.task_id);parent=s.get(TaskORM,meta.parent_task_id)
                child_season=target_id if meta.task_id in moving else child.season_id if child else None
                parent_season=target_id if meta.parent_task_id in moving else parent.season_id if parent else None
                if child_season!=parent_season:raise Conflict("Season correction must preserve task hierarchy")
            from database import TaskLinkORM
            for link in s.query(TaskLinkORM):
                if link.source_task_id not in moving and link.target_task_id not in moving:continue
                left=s.get(TaskORM,link.source_task_id);right=s.get(TaskORM,link.target_task_id)
                left_season=target_id if link.source_task_id in moving else left.season_id if left else None
                right_season=target_id if link.target_task_id in moving else right.season_id if right else None
                if left_season!=right_season:raise Conflict("Season correction must preserve task relations")
            if obj.revision != revision:
                raise revision_conflict()
            source_id = obj.season_id
            source = s.get(SeasonORM, source_id)
            if source_id == target_id:
                raise InvalidInput("Source and target must differ")
            if not source or source.state == "closed":
                raise season_closed("Conflict: source season is closed")
            if kind != "event" and target.state == "planned":
                raise InvalidInput("Only event hierarchy can move to a planned season")
            for item in [*tasks, *merits]:
                if item.season_id != source_id:
                    raise Conflict("Conflict: inconsistent hierarchy season")
                if dt(item.deadline_at) > dt(target.ends_at):
                    raise InvalidInput("Child deadline exceeds target season")
            if any(r.season_id != source_id for r in reports):
                raise Conflict("Conflict: inconsistent report season")
            if kind == "event":
                obj.season_id = target_id
                obj.revision += 1
            for item in [*tasks, *merits]:
                if isinstance(item,TaskORM):
                    from tracker import metadata, activity
                    meta=metadata(s,item);meta.assessment_revision=(meta.assessment_revision or 1)+1
                    activity(s,item,"task_updated",uid,"Изменён сезон задачи",changes=[
                        dict(field="season_id",label="Сезон",before=source_id,after=target_id)])
                item.season_id = target_id
                item.revision += 1
            for report in reports:
                report.season_id = target_id
                report.revision += 1
            aids = [
                a.assignment_id
                for a in s.query(AssignmentORM).filter(
                    AssignmentORM.task_id.in_([t.task_id for t in tasks])
                )
            ]
            mids = [m.merit_id for m in merits]
            s.query(ContributionORM).filter(
                (ContributionORM.assignment_id.in_(aids))
                | (ContributionORM.merit_id.in_(mids))
            ).update({"season_id": target_id}, synchronize_session=False)
            # The chair's independent works are one source table per season.
            # Moving a work must also move its stable source identity.
            from season_summaries import chair_merit_table_id
            s.query(ContributionORM).filter(
                ContributionORM.merit_id.in_(mids),
                ContributionORM.source_kind == "chair_merit",
            ).update({"source_id": chair_merit_table_id(target_id)}, synchronize_session=False)
            s.add(
                SeasonCorrectionORM(
                    correction_id=str(uuid.uuid4()),
                    object_kind=kind,
                    object_id=id,
                    source_season_id=source_id,
                    target_season_id=target_id,
                    changed_by_user_id=uid,
                    reason=reason,
                    created_at=now(),
                )
            )
            audit(
                s,
                kind,
                id,
                uid,
                reason,
                dict(season_id=source_id),
                dict(season_id=target_id),
            )
            refresh(s, source_id, uid, reason)
            refresh(s, target_id, uid, reason)
            s.commit()
            return SeasonCorrectionResult(
                object_kind=kind,
                object_id=id,
                source_season_id=source_id,
                target_season_id=target_id,
                revision=obj.revision,
            )
