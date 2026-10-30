"""One optimistic, atomic accounting command for shared criteria and all assignees."""
from dataclasses import asdict
import json
import math
from typing import Literal
from fastapi import Depends
from pydantic import Field, StrictFloat, StrictInt
from validation import Command, hours as validate_hours, assessment
from errors import InvalidInput, Forbidden, NotFound, revision_conflict, Conflict
from auth import get_current_user
from models import User
from database import ContributionORM, db, TaskORM, TaskTrackerORM, SeasonORM, AssignmentORM, UserORM, _user_to_ref_dc, _recalculate_assignment_contribution
from registration import audit, now
import access

CRITERIA = {'unique','creative','external_communication','in_person','fixed_time'}


def _load(session, task_id, uid, write=False):
    task=session.get(TaskORM,task_id)
    if not task or not db.can_read_task(uid,task,session):raise NotFound('Task not found')
    season=session.get(SeasonORM,task.season_id)
    if not season or task.scope_kind=='queue':raise InvalidInput('Bind the queue to an accounting scope first','accounting_scope_required')
    meta=session.query(TaskTrackerORM).filter_by(task_id=task_id).first()
    from tracker import public_status
    if not meta or public_status(meta.status)!='closed':raise Conflict('Close the task before filling accounting','task_not_closed')
    db.require_task_right(uid,'task.inputs.edit' if write else 'task.inputs.view',task,season.state,'Accounting access required','Only chair and deputies can correct closed season accounting')
    from domain_models import KkrControlEpicORM
    if session.query(KkrControlEpicORM).filter_by(task_id=task_id).first():raise InvalidInput('A control epic is not an accounting work task','control_epic_managed')
    return task,meta,season


def projection(task_id, uid):
    with db._session() as session:
        task,meta,season=_load(session,task_id,uid)
        editable=access.allowed(uid,'task.inputs.edit',task.scope_kind,task.scope_id,state=season.state)
        from tracker import participants
        current={row.assignment_id for row in participants(session,task_id)}
        rows=[]
        for row in session.query(AssignmentORM).filter_by(task_id=task_id).order_by(AssignmentORM.created_at,AssignmentORM.assignment_id):
            ref=_user_to_ref_dc(session.get(UserORM,row.assignee_user_id))
            rows.append(dict(assignment_id=row.assignment_id,assignee=asdict(ref),hours=row.hours,evaluation=row.evaluation,
                excluded=row.status=='cancelled',effective_completed_at=row.effective_completed_at,revision=row.inputs_revision,
                is_current=row.assignment_id in current))
        return dict(task_id=task_id,public_revision=task.revision,revision=meta.assessment_revision,
            criteria=json.loads(task.criteria_json),closed_at=meta.closed_at,season_closed=season.state=='closed',
            assigned_at=task.assigned_at,deadline_at=task.deadline_at,assignments=rows,
            capabilities=(['edit_assessment_inputs'] if editable else [])+(['edit_assessment_dates'] if access.allowed(uid,'task.dates.edit',task.scope_kind,task.scope_id,state=season.state) else []))


class BatchRow(Command):
    assignment_id:str
    expected_revision:StrictInt=Field(ge=1)
    hours:StrictFloat|StrictInt|None=None
    evaluation:Literal[-1,0,1,1.5]|None=None
    excluded:bool=False


class AccountingBatch(Command):
    expected_public_revision:StrictInt=Field(ge=1)
    expected_revision:StrictInt=Field(ge=1)
    criteria:dict[str,bool]
    assignments:list[BatchRow]=Field(max_length=500)
    reason:str|None=None
    template_selection:dict|None=None


def save(task_id, payload, uid):
    with db.atomic():
      with db._session() as session:
        task,meta,season=_load(session,task_id,uid,True)
        if payload.expected_public_revision!=task.revision or payload.expected_revision!=meta.assessment_revision:raise revision_conflict()
        rows={r.assignment_id:r for r in session.query(AssignmentORM).filter_by(task_id=task_id)}
        given=[r.assignment_id for r in payload.assignments]
        if len(set(given))!=len(given) or set(given)!=set(rows):raise revision_conflict('The task assignees changed; reload accounting')
        if set(payload.criteria)!=CRITERIA:raise InvalidInput('Invalid criteria')
        reason=(payload.reason or '').strip()
        if season.state=='closed' and not reason:raise InvalidInput('A closed season correction requires a reason')
        reason=reason or 'Заполнение ККР закрытой задачи'
        # Validate the complete snapshot before touching a single row. 0 is a value.
        for value in payload.assignments:
            row=rows[value.assignment_id]
            if value.expected_revision!=row.inputs_revision:raise revision_conflict()
            if value.hours is not None:validate_hours(value.hours)
            if not value.excluded:
                if value.hours is None or value.evaluation is None:raise InvalidInput('Hours and evaluation are required for every included assignee','missing_assessment')
                assessment(value.evaluation,meta.closed_at or row.effective_completed_at)
        old_criteria=json.loads(task.criteria_json)
        if old_criteria!=payload.criteria:
            task.criteria_json=json.dumps(payload.criteria);meta.assessment_revision+=1
            audit(session,'task',task_id,uid,reason,{'criteria':old_criteria},{'criteria':payload.criteria})
        stamp=now()
        for value in payload.assignments:
            row=rows[value.assignment_id]
            old=dict(hours=row.hours,evaluation=row.evaluation,effective_completed_at=row.effective_completed_at,status=row.status)
            row.status='cancelled' if value.excluded else ('accepted' if value.evaluation in (1,1.5) else 'not_completed')
            row.hours=value.hours
            row.evaluation=None if value.excluded else value.evaluation
            # Server-observed public closure is authoritative; never trust a client date.
            if meta.closed_at:row.effective_completed_at=meta.closed_at
            row.updated_at=stamp
            new=dict(hours=row.hours,evaluation=row.evaluation,effective_completed_at=row.effective_completed_at,status=row.status)
            if old!=new:audit(session,'assignment',row.assignment_id,uid,reason,old,new)
            _recalculate_assignment_contribution(session,row,task)
            if payload.template_selection:
                from profile_features import capture_template_use
                capture_template_use(session,uid,payload.template_selection,'assessment',row.assignment_id,
                    dict(hours=row.hours,evaluation=row.evaluation,criteria=payload.criteria))
        session.flush()
        if any(score is not None and not math.isfinite(score) for (score,) in session.query(ContributionORM.score).filter(ContributionORM.assignment_id.in_(rows))):
            raise InvalidInput("Accounting result must be finite")
        from season_summaries import refresh
        refresh(session,task.season_id,uid,reason)
        session.flush()
        return projection(task_id,uid)


def register_routes(router):
    @router.get('/tasks/{task_id}/accounting-batch')
    def get_batch(task_id:str,cur:User=Depends(get_current_user)):
        return projection(task_id,cur.user_id)
    @router.put('/tasks/{task_id}/accounting-batch')
    def put_batch(task_id:str,payload:AccountingBatch,cur:User=Depends(get_current_user)):
        return save(task_id,payload,cur.user_id)
