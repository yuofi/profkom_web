"""Shared task workflow, additive metadata and a public activity projection.

TaskTrackerORM.status is the authoritative shared workflow. AssignmentORM.status
also carries a private personal accounting outcome: assignee work actions preserve any
final personal outcome, inputs and credits. Only an authorized review changes that
accounting outcome. Task DTOs project the common workflow without leaking private
assessment changes; superseded assignments and legacy outcomes are never silently
rewritten. Public activity deliberately excludes assessment inputs/AuditLog.
"""
from datetime import datetime, timezone
from dataclasses import asdict
import json
import uuid

from sqlalchemy import event
from sqlalchemy.inspection import inspect
from sqlalchemy.orm import Session

from database import (db, SessionLocal, engine, TaskORM, AssignmentORM, SubmissionORM,
    TaskTrackerORM, TaskActivityORM, TaskSubmissionORM, CommentORM, FileRecordORM,
    SeasonORM, BlockORM, SubeventORM, UserORM, AuditLogORM, _user_to_ref_dc,
    _recalculate_assignment_contribution, _task_caps, _assignment_orm_to_dc)
from errors import Conflict, Forbidden, InvalidInput, NotFound, revision_conflict, season_closed

STATUSES = ("assigned", "in_progress", "help_required", "submitted", "accepted", "needs_revision", "not_completed", "cancelled")
ACTIVE = {"assigned", "in_progress", "help_required", "submitted", "needs_revision"}
LABELS = {"assigned":"Назначена", "in_progress":"В работе", "help_required":"Нужна помощь", "submitted":"На проверке", "accepted":"Принята", "needs_revision":"На доработке", "not_completed":"Не выполнена", "cancelled":"Отменена"}


def now(): return datetime.now(timezone.utc).isoformat()


def _rows(session, model, **filters):
    rows = session.query(model).filter_by(**filters).all()
    rows += [obj for obj in session.new if isinstance(obj, model) and all(getattr(obj,k)==v for k,v in filters.items()) and obj not in rows]
    return rows


def participants(session, task_id):
    """A former assignment explicitly replaced by reassign is historical, not a teammate."""
    rows = _rows(session, AssignmentORM, task_id=task_id)
    ids = {a.assignment_id for a in rows}
    superseded = set()
    logs = session.query(AuditLogORM).filter(AuditLogORM.target_kind=="assignment", AuditLogORM.target_id.in_(ids)).all() if ids else []
    logs += [x for x in session.new if isinstance(x,AuditLogORM) and x.target_kind=="assignment" and x.target_id in ids]
    for item in logs:
        data = json.loads(item.new_values_json or "{}")
        if data.get("new_assignment_id") in ids: superseded.add(item.target_id)
    return [a for a in rows if a.assignment_id not in superseded]


def status_of(rows):
    return status_values({a.status or "assigned" for a in rows})


def status_values(states):
    if not states:return "assigned",False
    if len(states)==1:return next(iter(states)),False
    # This is an explicit legacy projection; never updates the individual outcomes.
    for status in ["help_required","needs_revision","in_progress","assigned","submitted","not_completed","accepted","cancelled"]:
        if status in states:return status,True


def metadata(session, task, queue=None):
    rows=_rows(session,TaskTrackerORM,task_id=task.task_id)
    if rows:return rows[0]
    status,mixed=status_of(participants(session,task.task_id))
    item=TaskTrackerORM(task_id=task.task_id,status=status,legacy_mixed_statuses=mixed,
        public_statuses_json=json.dumps({a.assignment_id:(a.status or "assigned") for a in _rows(session,AssignmentORM,task_id=task.task_id)}),public_updated_at=None,files_json="[]")
    session.add(item)
    from task_queues import bind_task
    bind_task(session,task,item,queue)
    return item


def activity(session, task, kind, actor, description, *, at=None, before=None, after=None, changes=None):
    at=at or now();meta=metadata(session,task);meta.public_updated_at=at
    session.add(TaskActivityORM(event_id="activity-"+str(uuid.uuid4()),task_id=task.task_id,
        kind=kind,actor_user_id=actor,created_at=at,description=description,from_status=before,to_status=after,changes_json=json.dumps(changes or ([dict(field="status",label="Статус",before=before,after=after)] if before is not None or after is not None else []),ensure_ascii=False)))


def seed_existing():
    """Repeatable migration adds numbers only; no assignments, scores or dates are guessed."""
    from task_queues import migrate_columns
    migrate_columns()
    from sqlalchemy import text
    with engine.begin() as connection:
        names={row[1] for row in connection.execute(text("pragma table_info(task_tracker)"))}
        if "public_statuses_json" not in names:connection.execute(text("alter table task_tracker add column public_statuses_json TEXT NOT NULL DEFAULT '{}'"))
    with SessionLocal() as session:
        for task in session.query(TaskORM).order_by(TaskORM.created_at,TaskORM.task_id):
            meta=metadata(session,task)
            if not json.loads(meta.public_statuses_json or "{}"):
                meta.public_statuses_json=json.dumps({a.assignment_id:(a.status or "assigned") for a in _rows(session,AssignmentORM,task_id=task.task_id)})
        session.commit()
    from task_queues import migrate
    migrate()


def install_activity_hooks():
    if getattr(install_activity_hooks,"installed",False):return
    install_activity_hooks.installed=True
    @event.listens_for(Session,"before_flush")
    def public_changes(session,_context,_instances):
        if session.info.get("tracker_batch"):return
        from access import actor_id
        actor=actor_id.get() or session.info.get("tracker_actor")
        for obj in list(session.new):
            if isinstance(obj,TaskORM):
                metadata(session,obj)
                activity(session,obj,"task_created",obj.created_by_user_id,"Задача создана",at=obj.created_at,
                    changes=[dict(field="title",label="Название",before=None,after=obj.title),
                        dict(field="description",label="Описание",before=None,after=json.loads(obj.description_json or '{}').get('body','')),
                        dict(field="deadline_at",label="Срок",before=None,after=obj.deadline_at),
                        dict(field="status",label="Статус",before=None,after=metadata(session,obj).status)])
            elif isinstance(obj,CommentORM):
                task=session.get(TaskORM,obj.task_id)
                if task:activity(session,task,"comment_added",obj.author_user_id,"Добавлен комментарий",at=obj.created_at,
                    changes=[dict(field="comment",label="Комментарий",before=None,after=json.loads(obj.content_json or '{}').get('body',''))])
        for obj in list(session.dirty):
            if isinstance(obj,TaskORM):
                fields=[name for name in ("title","description_json","deadline_at") if inspect(obj).attrs[name].history.has_changes()]
                if fields:
                    changes=[]
                    for name in fields:
                        hist=inspect(obj).attrs[name].history
                        before=hist.deleted[0] if hist.deleted else None
                        after=hist.added[0] if hist.added else getattr(obj,name)
                        field,label={"title":("title","Название"),"description_json":("description","Описание"),"deadline_at":("deadline_at","Срок")}[name]
                        if name=="description_json":
                            before=json.loads(before or '{}').get('body','');after=json.loads(after or '{}').get('body','')
                        changes.append(dict(field=field,label=label,before=before,after=after))
                    activity(session,obj,"task_updated",actor,"Изменены параметры задачи",changes=changes)
            elif isinstance(obj,CommentORM) and inspect(obj).attrs.content_json.history.has_changes():
                task=session.get(TaskORM,obj.task_id)
                if task:
                    hist=inspect(obj).attrs.content_json.history
                    before=json.loads(hist.deleted[0] if hist.deleted else '{}').get('body','')
                    after=json.loads(obj.content_json).get('body','')
                    activity(session,task,"comment_edited",actor,"Комментарий отредактирован",at=obj.updated_at,
                        changes=[dict(field="comment",label="Комментарий",before=before,after=after)])
            elif isinstance(obj,AssignmentORM) and inspect(obj).attrs.status.history.has_changes():
                private = any(isinstance(audit,AuditLogORM) and audit.target_kind=="assignment" and audit.target_id==obj.assignment_id and "hours" in json.loads(audit.old_values_json or "{}") for audit in session.new)
                reassigned=any(isinstance(audit,AuditLogORM) and audit.target_kind=="assignment" and audit.target_id==obj.assignment_id and "new_assignment_id" in json.loads(audit.new_values_json or "{}") for audit in session.new)
                if private or reassigned:continue
                task=session.get(TaskORM,obj.task_id)
                if task:
                    hist=inspect(obj).attrs.status.history
                    meta=metadata(session,task)
                    public=json.loads(meta.public_statuses_json or "{}")
                    before=public.get(obj.assignment_id,hist.deleted[0] if hist.deleted else None)
                    public[obj.assignment_id]=obj.status
                    meta.public_statuses_json=json.dumps(public)
                    status,mixed=status_values({public.get(a.assignment_id,a.status) for a in participants(session,obj.task_id)})
                    meta.status=status;meta.legacy_mixed_statuses=mixed
                    activity(session,task,"assignment_status_changed",actor,"Изменён статус прежнего назначения",at=obj.updated_at,before=before,after=obj.status)


def _file_refs(session, ids):
    result=[]
    for fid in ids:
        row=session.get(FileRecordORM,fid)
        if row and row.state=="completed":result.append(dict(file_id=row.file_id,name=row.name,mime_type=row.mime_type,size_bytes=row.size_bytes))
    return result


def can_work(session,task,uid):
    user=session.get(UserORM,uid)
    return bool(user and not user.banned and user.account_state=="active" and
        db.can_read_task(uid,task,session) and
        any(a.assignee_user_id==uid for a in participants(session,task.task_id)))


def _submission_dict(session,row,shared=True):
    ref=_user_to_ref_dc(session.get(UserORM,row.created_by_user_id))
    return dict(submission_id=row.submission_id,submitted_at=row.submitted_at,
        submitted_by=asdict(ref) if ref else None,text=json.loads(row.text_json),
        links=json.loads(row.links_json),files=_file_refs(session,json.loads(row.files_json)))


def enrich_task(session,task,result,uid):
    meta=metadata(session,task)
    if meta.task_number is None:session.flush()
    from task_queues import task_queue,queue_ref,task_read
    queue=task_queue(session,task)
    result.queue=queue_ref(queue) if queue else None
    result.task_key=queue.key+"-"+str(meta.queue_number) if queue and meta.queue_number else "TASK-"+str(meta.task_number)
    result.legacy_task_key=meta.legacy_task_key
    parent=session.get(TaskORM,meta.parent_task_id) if meta.parent_task_id else None
    result.parent_task_unavailable=bool(meta.parent_task_id and (not parent or not task_read(session,parent,uid)))
    result.parent_task_id=None if result.parent_task_unavailable else meta.parent_task_id
    if parent and not result.parent_task_unavailable:
        parent_meta=metadata(session,parent);parent_queue=task_queue(session,parent)
        result.parent_task=dict(task_id=parent.task_id,task_key=parent_queue.key+"-"+str(parent_meta.queue_number) if parent_queue else "TASK-"+str(parent_meta.task_number),title=parent.title)
    result.status=meta.status
    result.legacy_status_conflict=meta.legacy_mixed_statuses
    current_ids={a.assignment_id for a in participants(session,task.task_id)}
    public_statuses=json.loads(meta.public_statuses_json or "{}")
    season=session.get(SeasonORM,task.season_id)
    worker_caps={"start_assignment","resume_assignment","request_help","submit_result"}
    for assignment in result.assignments:
        visible_status=public_statuses.get(assignment.assignment_id,assignment.status)
        if assignment.assignment_id in current_ids and not result.legacy_status_conflict:visible_status=result.status
        assignment.status=visible_status
        assignment.capabilities=[c for c in assignment.capabilities if c not in worker_caps]
        if uid and season.state != "closed" and assignment.assignment_id in current_ids and assignment.assignee.user_id==uid and can_work(session,task,uid):
            if visible_status=="assigned":assignment.capabilities += ["start_assignment","submit_result","request_help"]
            if visible_status in {"in_progress","help_required","needs_revision"}:assignment.capabilities.append("submit_result")
            if visible_status in {"in_progress","needs_revision"}:assignment.capabilities.append("request_help")
            if visible_status=="help_required":assignment.capabilities.append("resume_assignment")
    result.assignees=[_user_to_ref_dc(session.get(UserORM,a.assignee_user_id)) for a in participants(session,task.task_id)]
    result.assignees=[user for user in result.assignees if user is not None]
    result.created_by=_user_to_ref_dc(session.get(UserORM,task.created_by_user_id))
    result.created_at=task.created_at
    result.updated_at=meta.public_updated_at
    owner=session.get(BlockORM,task.scope_id) if task.scope_kind=="block" else session.get(SubeventORM,task.scope_id)
    result.scope_title=(owner.name if task.scope_kind=="block" else owner.title) if owner else "Команда"
    result.attachments=_file_refs(session,json.loads(meta.files_json or "[]"))
    rows=session.query(TaskSubmissionORM).filter_by(task_id=task.task_id).order_by(TaskSubmissionORM.submitted_at).all()
    result.submissions=[_submission_dict(session,row) for row in rows]
    if not rows:
        aids=[a.assignment_id for a in participants(session,task.task_id)]
        old=session.query(SubmissionORM).filter(SubmissionORM.assignment_id.in_(aids)).order_by(SubmissionORM.submitted_at).all() if aids else []
        result.submissions=[_submission_dict(session,row,False) for row in old]
    if uid:
        state=session.get(SeasonORM,task.season_id).state
        if state!="closed" and can_work(session,task,uid):
            if result.status=="assigned":result.capabilities.append("start_task")
            if result.status=="help_required":result.capabilities.append("resume_task")
            if result.status in {"assigned","in_progress","needs_revision"}:result.capabilities.append("request_task_help")
            if result.status in {"assigned","in_progress","help_required","needs_revision"}:result.capabilities.append("submit_task_result")
        result.capabilities+=_task_caps(task,uid,{"review_task":"task.review","attach_task_file":"task.edit"})
        if can_edit_description(session,task,uid):result.capabilities.append("edit_task_description")
    return result


def can_edit_description(session,task,uid):
    import access
    if not db.can_read_task(uid,task,session):return False
    state=session.get(SeasonORM,task.season_id).state
    return access.allowed(uid,"task.edit",task.scope_kind,task.scope_id,state=state) or (state!="closed" and can_work(session,task,uid))


def can_edit_comment(session,comment,uid):
    task=session.get(TaskORM,comment.task_id)
    return bool(task and db.can_read_task(uid,task,session) and (comment.author_user_id==uid or task.created_by_user_id==uid or can_work(session,task,uid)))


def public_changes(session,event,uid):
    from task_queues import task_read,task_queue
    allowed={"title","description","deadline_at","status","comment","attachments","parent_task_id","assignees"}
    changes=[]
    for raw in json.loads(event.changes_json or "[]"):
        if raw.get("field") not in allowed:continue
        item={k:raw[k] for k in ("field","label","before","after") if k in raw}
        if item['field']=='parent_task_id':
            for side in ('before','after'):
                parent=session.get(TaskORM,item.get(side)) if item.get(side) else None
                if parent and task_read(session,parent,uid):
                    q=task_queue(session,parent);m=metadata(session,parent)
                    item[side]=(q.key+'-'+str(m.queue_number)) if q else 'TASK-'+str(m.task_number)
                elif item.get(side):item[side]='Недоступная задача'
        changes.append(item)
    return changes


def visible_task(session,task_id,uid):
    task=session.get(TaskORM,task_id)
    if not task or not db.can_read_task(uid,task,session):raise NotFound("Task not found")
    return task


def history(task_id,uid):
    with db._session() as session:
        task=visible_task(session,task_id,uid)
        events=session.query(TaskActivityORM).filter_by(task_id=task_id).order_by(TaskActivityORM.created_at,TaskActivityORM.event_id).all()
        result=[]
        if not any(e.kind=="task_created" for e in events):
            ref=_user_to_ref_dc(session.get(UserORM,task.created_by_user_id))
            result.append(dict(event_id="created:"+task_id,kind="task_created",created_at=task.created_at,actor=asdict(ref) if ref else None,description="Задача создана",from_status=None,to_status=None,changes=[]))
        for row in events:
            ref=_user_to_ref_dc(session.get(UserORM,row.actor_user_id)) if row.actor_user_id else None
            result.append(dict(event_id=row.event_id,kind=row.kind,created_at=row.created_at,actor=asdict(ref) if ref else None,description=row.description,from_status=row.from_status,to_status=row.to_status,changes=public_changes(session,row,uid)))
        return result


def patch_files(task_id,uid,expected_revision,file_ids,*,increment_revision=True):
    from file_access import check_attachments
    with db._session() as session:
        task=visible_task(session,task_id,uid);state=session.get(SeasonORM,task.season_id).state
        db.require_task_right(uid,"task.edit",task,state,"Forbidden: cannot attach task files","Forbidden: cannot edit closed task files")
        if task.revision!=expected_revision:raise revision_conflict()
        check_attachments(session,file_ids,"task",task_id,uid)
        if any(session.get(FileRecordORM,fid).purpose!="attachment" for fid in file_ids):raise Forbidden("Forbidden: invalid task attachment purpose")
        meta=metadata(session,task);before=json.loads(meta.files_json or "[]")
        meta.files_json=json.dumps(file_ids)
        if increment_revision:task.revision+=1
        if before!=file_ids:activity(session,task,"attachments_updated",uid,"Изменены вложения задачи",changes=[dict(field="attachments",label="Вложения",before=[x["name"] for x in _file_refs(session,before)],after=[x["name"] for x in _file_refs(session,file_ids)])])
        session.commit()
        return db.get_task(task_id,uid)


def change_status(task_id,uid,expected_revision,status,*,text="",links=None,file_ids=None,message=None,evaluation=None,review_note=None,reason=None,evaluations=None,legacy_assignment=None):
    from file_access import check_attachments
    import access
    from notifications import emit
    from season_summaries import refresh
    if status not in STATUSES:raise InvalidInput("Unsupported task status")
    links=links or [];file_ids=file_ids or [];reason=reason or review_note or ""
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,uid);state=session.get(SeasonORM,task.season_id).state
        rows=participants(session,task_id);meta=metadata(session,task);old,mixed=meta.status,meta.legacy_mixed_statuses
        if not rows:raise Conflict("Task has no current assignees")
        worker=status in {"in_progress","help_required","submitted"}
        if worker:
            if state=="closed":raise season_closed()
            if not can_work(session,task,uid):raise Forbidden("Forbidden: only a current assignee can work on this task")
        else:db.require_task_right(uid,"task.review",task,state,"Forbidden: cannot review this task","Forbidden: cannot review a closed task")
        if task.revision!=expected_revision:raise revision_conflict()
        allowed={"in_progress":{"assigned","help_required"},"help_required":{"assigned","in_progress","needs_revision"},"submitted":{"assigned","in_progress","help_required","needs_revision"},"accepted":{"submitted"},"needs_revision":{"submitted","accepted"},"not_completed":ACTIVE,"cancelled":ACTIVE}
        if status=="assigned":raise Conflict("Task cannot return to its initial state")
        if old==status and not mixed:raise Conflict("Task already has this status")
        # A legacy task can converge only if every old outcome can take this exact action.
        if old not in allowed[status] and not mixed:raise Conflict("Task status does not permit this transition")
        public_statuses=json.loads(meta.public_statuses_json or "{}")
        if mixed:
            for row in rows:
                visible=public_statuses.get(row.assignment_id,row.status)
                if visible==status:continue
                if visible not in allowed[status]:raise Conflict("Legacy assignment outcomes require an explicit compatible decision","legacy_task_statuses")
        if status in {"needs_revision","not_completed","cancelled"} and not reason.strip():raise InvalidInput("Reason is required")
        if status=="accepted" and evaluation not in (1,1.5):raise InvalidInput("Evaluation must be 1 or 1.5")
        if status=="not_completed" and evaluation not in (0,-1):raise InvalidInput("Evaluation must be 0 or -1")
        overrides={item['assignment_id']:item['evaluation'] for item in (evaluations or [])}
        if len(overrides)!=len(evaluations or []) or set(overrides)-{a.assignment_id for a in rows}:raise InvalidInput("Invalid individual evaluations")
        if status not in {"accepted","not_completed"} and overrides:raise InvalidInput("Evaluations require a final decision")
        if any(v not in ((1,1.5) if status=="accepted" else (0,-1)) for v in overrides.values()):raise InvalidInput("Invalid individual evaluation")
        if status=="accepted" and any(a.hours is None for a in rows):raise InvalidInput("Hours must be set for every assignee")
        if status=="submitted":
            if not text.strip() and not links and not file_ids:raise InvalidInput("A result, link or file is required")
            if any(not link.startswith(("https://","http://")) for link in links):raise InvalidInput("Invalid result link")
            if legacy_assignment:
                check_attachments(session,file_ids,"assignment",legacy_assignment,uid)
            else:
                check_attachments(session,file_ids,"task",task_id,uid)
                if any(session.get(FileRecordORM,fid).purpose!="submission" for fid in file_ids):raise Forbidden("Forbidden: invalid submission purpose")
        stamp=now();session.info['tracker_batch']=True
        try:
            if status=="submitted":
                session.add(TaskSubmissionORM(submission_id="task-submission-"+str(uuid.uuid4()),task_id=task_id,submitted_at=stamp,created_by_user_id=uid,text_json=json.dumps({"format":"markdown","body":text}),links_json=json.dumps(links),files_json=json.dumps(file_ids)))
                # A compatibility projection for old consumers, with one byte/file payload.
                if legacy_assignment:
                    session.add(SubmissionORM(submission_id="submission-"+str(uuid.uuid4()),assignment_id=legacy_assignment,submitted_at=stamp,created_by_user_id=uid,text_json=json.dumps({"format":"markdown","body":text}),links_json=json.dumps(links),files_json=json.dumps(file_ids)))
            for row in rows:
                if public_statuses.get(row.assignment_id,row.status)==status and mixed:continue
                old_personal_status,old_evaluation=row.status,row.evaluation
                preserve_private_final = worker and row.status in {"accepted","not_completed"}
                if not preserve_private_final:row.status=status
                row.revision+=1;row.updated_at=stamp
                if status=="submitted" and not preserve_private_final:row.effective_completed_at=stamp
                if status=="accepted":
                    row.evaluation=overrides.get(row.assignment_id,row.evaluation if row.evaluation in (1,1.5) else evaluation)
                    row.review_note=review_note
                    if not row.effective_completed_at:raise InvalidInput("Shared submission required before acceptance")
                elif status=="not_completed":row.evaluation=overrides.get(row.assignment_id,evaluation);row.review_note=reason
                elif status=="cancelled":row.evaluation=None;row.review_note=reason
                elif status=="needs_revision":row.review_note=reason
                if status in {"accepted","not_completed","cancelled","needs_revision"}:
                    session.add(AuditLogORM(target_kind="assignment",target_id=row.assignment_id,changed_by_user_id=uid,reason=reason or review_note or "Shared task accepted",old_values_json=json.dumps({"status":old_personal_status,"evaluation":old_evaluation}),new_values_json=json.dumps({"status":status,"evaluation":row.evaluation}),created_at=stamp))
                    _recalculate_assignment_contribution(session,row,task)
            if status=="help_required" and message and message.strip():
                session.add(CommentORM(comment_id="comment-"+str(uuid.uuid4()),task_id=task_id,author_user_id=uid,content_json=json.dumps({"format":"markdown","body":message}),history_json="[]",created_at=stamp))
                activity(session,task,"comment_added",uid,"Добавлен комментарий",at=stamp,
                    changes=[dict(field="comment",label="Комментарий",before=None,after=message)])
            meta=metadata(session,task);meta.status=status;meta.legacy_mixed_statuses=False
            for row in rows:public_statuses[row.assignment_id]=status
            meta.public_statuses_json=json.dumps(public_statuses);task.revision+=1
            activity(session,task,"status_changed",uid,"Изменён статус задачи",at=stamp,before=old,after=status)
            if status in {"accepted","not_completed","cancelled","needs_revision"}:refresh(session,task.season_id,uid,reason or "Shared task decision")
            recipients=[a.assignee_user_id for a in rows]
            if status=="help_required":recipients=db.get_scope_leads(task.scope_kind,task.scope_id)
            kind={"help_required":"task_help_required","needs_revision":"task_revision_requested","accepted":"task_accepted"}.get(status,"task_status_changed")
            recipients=[recipient for recipient in recipients if db.can_read_task(recipient,task,session)]
            emit(session,recipients,kind,dict(task_id=task_id,title=task.title,status=status),"task-status:"+task_id+":"+str(task.revision),uid)
            session.commit()
        finally:session.info.pop('tracker_batch',None)
        return db.get_task(task_id,uid)


def legacy_command(assignment_id,uid,expected_revision,status,*,required_source_status=None,**kwargs):
    """Old URLs retain their ownership/revision boundary, then execute one joint command."""
    with db.atomic():
      with db._session() as session:
        row=session.get(AssignmentORM,assignment_id)
        if not row:raise NotFound("Assignment not found")
        task=session.get(TaskORM,row.task_id)
        if not task or not db.can_read_task(uid,task,session):raise Forbidden("Forbidden: scope access ended")
        if status in {"in_progress","help_required","submitted"}:
            if row.assignee_user_id!=uid:raise Forbidden("Forbidden: only assignee can work on assignment")
            if session.get(SeasonORM,task.season_id).state=="closed":raise season_closed()
        else:
            state=session.get(SeasonORM,task.season_id).state
            db.require_task_right(uid,"task.review",task,state,"Forbidden: cannot review this task","Forbidden: cannot review a closed task")
        if row.revision!=expected_revision:raise revision_conflict()
        if row.assignment_id not in {a.assignment_id for a in participants(session,task.task_id)}:
            raise Conflict("Historical assignment cannot change the joint task")
        if required_source_status is not None and metadata(session,task).status!=required_source_status:
            raise Conflict("Task status does not permit this legacy command")
        updated=change_status(task.task_id,uid,task.revision,status,legacy_assignment=assignment_id,**kwargs)
        return next(item for item in updated.assignments if item.assignment_id==assignment_id)


def task_page(uid,*,queue_id=None,season_id=None,scope_kind=None,scope_id=None,mine=False,status=None,q="",unfinished=False,overdue=False,assignee_user_id=None,sort="deadline",order="asc",cursor=None,limit=20,converter):
    from api_contract import cursor_page
    from membership import legacy_name,scope_out
    internal_scope=legacy_name(scope_id) if scope_kind=="block" and scope_id else scope_id
    rows=db.list_tasks(current_user_id=uid,season_id=season_id,scope_kind=scope_kind,scope_id=internal_scope)
    if queue_id:
        from task_queues import get
        get(queue_id,uid)
        rows=[t for t in rows if t.queue and t.queue["queue_id"]==queue_id]
    scopes={};assignees={}
    for task in rows:
        scope=scope_out(task.scope);scopes[(scope['kind'],scope['id'])]=dict(**scope,title=task.scope_title)
        for person in task.assignees:
            if person.user_id is not None:assignees[person.user_id]=asdict(person)
    if mine:rows=[t for t in rows if any(a.user_id==uid for a in t.assignees)]
    if assignee_user_id is not None:rows=[t for t in rows if any(a.user_id==assignee_user_id for a in t.assignees)]
    if status:rows=[t for t in rows if t.status==status]
    if unfinished:rows=[t for t in rows if t.status in ACTIVE]
    if overdue:
        current=datetime.now(timezone.utc)
        rows=[t for t in rows if t.status in ACTIVE and datetime.fromisoformat(t.deadline_at.replace('Z','+00:00'))<current]
    needle=q.strip().casefold()
    if needle:rows=[t for t in rows if needle in t.title.casefold() or needle in t.task_key.casefold() or (t.legacy_task_key and needle in t.legacy_task_key.casefold())]
    field={'deadline':'deadline_at','updated':'updated_at','created':'created_at'}[sort]
    def key(item):return (getattr(item,field) or item.created_at or "",item.task_id)
    import base64,hashlib,binascii
    context=hashlib.sha256(json.dumps(dict(uid=uid,queue_id=queue_id,season_id=season_id,scope_kind=scope_kind,scope_id=internal_scope,mine=mine,status=status,q=needle,unfinished=unfinished,overdue=overdue,assignee_user_id=assignee_user_id,sort=sort,order=order,limit=limit),sort_keys=True).encode()).hexdigest()
    inner=None
    if cursor:
        try:
            token=json.loads(base64.urlsafe_b64decode(cursor.encode('ascii')))
            if token.get('v')!=1 or token.get('context')!=context or not isinstance(token.get('key'),str):raise InvalidInput("Task cursor does not match these filters")
            inner=token['key']
        except (ValueError,TypeError,AttributeError,UnicodeError,binascii.Error):raise InvalidInput("Task cursor does not match these filters")
    page=cursor_page(rows,key,inner,descending=order=="desc",limit=limit)
    following=base64.urlsafe_b64encode(json.dumps(dict(v=1,context=context,key=page.next_cursor)).encode()).decode() if page.next_cursor else None
    return dict(items=[converter(item) for item in page.items],next_cursor=following,total=len(rows),
        scopes=sorted(scopes.values(),key=lambda x:(x['title'],x['id'])),
        assignees=sorted(assignees.values(),key=lambda x:(x['display_name'],x['user_id'])))
