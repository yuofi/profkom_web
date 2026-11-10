"""First season placement for block tasks; existing accounting moves remain corrections."""

from sqlalchemy import or_

from database import SeasonORM, TaskORM, TaskTrackerORM, TaskLinkORM, AssignmentORM, ContributionORM
from errors import Conflict, Forbidden, InvalidInput, NotFound, season_closed


def can_assign(session, task, uid, facts=None):
    if task.scope_kind != "block" or task.season_id is not None:
        return False
    from tracker import can_edit_public, can_close, is_control_task
    if facts.control() if facts is not None else is_control_task(session, task.task_id):
        return False
    return can_edit_public(session, task, uid, facts) or can_close(session, task, uid, facts)


def require_season(task):
    if task.scope_kind == "block" and not task.season_id:
        raise Conflict("Select a season before closing or assessing this task", "task_season_required")


def period(assigned, deadline, season, *, start="assigned_at", start_moved=False):
    """Seasonless tasks keep their own date ordering without an invented season end."""
    from validation import period as seasonal_period
    from participation import dt
    if season is not None:
        return seasonal_period(assigned, deadline, season.ends_at, start=start, start_moved=start_moved)
    if dt(assigned) <= dt(deadline):
        return
    if start_moved and start:
        raise InvalidInput("Assigned date must not be after the deadline", "assigned_out_of_range",
                           latest=dt(deadline).isoformat(), **{start: "out_of_range"})
    raise InvalidInput("Deadline must not be before the assigned date", "deadline_out_of_range",
                       deadline_at="out_of_range", earliest=dt(assigned).isoformat())


def assign(session, task, season_id, uid):
    """Apply one first placement inside the caller's write unit; caller bumps public revision.

    Neither input/KKR records nor an already assigned season can be moved here. A
    refusal after any mixed command is rolled back by the same outer transaction.
    """
    if task.scope_kind != "block":
        raise InvalidInput("Only block tasks can select a season separately", "task_season_scope")
    if task.season_id is not None:
        raise Conflict("Use season correction to change an assigned season", "task_season_correction_required")
    if not can_assign(session, task, uid):
        raise Forbidden("Cannot select the task season", "task_season_forbidden")
    if not season_id:
        require_season(task)
    season = session.get(SeasonORM, season_id)
    if season is None:
        raise NotFound("Season not found")
    if season.state == "closed":
        raise season_closed("Cannot assign a task to a closed season")
    if season.state not in {"planned", "open", "summarizing"}:
        raise Conflict("Season is not available", "task_season_unavailable")
    from tracker import metadata, activity
    from participation import dt
    meta = metadata(session, task)
    if task.deadline_at:
        period(task.assigned_at, task.deadline_at, season)
    if meta.starts_at and dt(meta.starts_at) > dt(season.ends_at):
        raise InvalidInput("Planned start exceeds target season", "task_season_dates")
    # Refuse corrupt/imported accounting too; never adopt a season implicitly.
    if session.query(ContributionORM).join(AssignmentORM, ContributionORM.assignment_id == AssignmentORM.assignment_id).filter(
            AssignmentORM.task_id == task.task_id).first():
        raise Conflict("Existing accounting requires a season correction", "task_season_correction_required")
    neighbors = set()
    if meta.parent_task_id:
        neighbors.add(meta.parent_task_id)
    neighbors.update(row.task_id for row in session.query(TaskTrackerORM.task_id).filter_by(parent_task_id=task.task_id))
    for link in session.query(TaskLinkORM).filter(or_(TaskLinkORM.source_task_id == task.task_id,
                                                     TaskLinkORM.target_task_id == task.task_id)):
        neighbors.add(link.target_task_id if link.source_task_id == task.task_id else link.source_task_id)
    if neighbors and session.query(TaskORM.task_id).filter(TaskORM.task_id.in_(neighbors),
            or_(TaskORM.season_id.is_(None), TaskORM.season_id != season_id)).first():
        # Do not disclose the linked task's title or identity when it is hidden.
        raise Conflict("Remove incompatible task hierarchy or links before selecting a season", "task_season_relations")
    task.season_id = season_id
    meta.assessment_revision = (meta.assessment_revision or 1) + 1
    activity(session, task, "task_updated", uid, "Указан сезон задачи", changes=[
        dict(field="season_id", label="Сезон", before=None, after=season_id)])
    return True
