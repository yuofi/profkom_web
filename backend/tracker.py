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
    TaskTrackerORM, TaskRosterORM, TaskActivityORM, TaskSubmissionORM, CommentORM, FileRecordORM,
    SeasonORM, BlockORM, SubeventORM, UserORM, AuditLogORM, _user_to_ref_dc,
    _recalculate_assignment_contribution, _task_caps, _assignment_orm_to_dc)
from errors import Conflict, Forbidden, InvalidInput, NotFound, revision_conflict, season_closed

STATUSES = ("assigned", "in_progress", "help_required", "submitted", "accepted", "needs_revision", "not_completed", "cancelled")
ACTIVE = {"assigned", "in_progress", "help_required", "submitted", "needs_revision"}
LABELS = {"assigned":"Открыта", "in_progress":"В работе", "help_required":"Нужна помощь", "submitted":"На проверке", "accepted":"Принята", "needs_revision":"На доработке", "not_completed":"Не выполнена", "cancelled":"Отменена"}


def now(): return datetime.now(timezone.utc).isoformat()


def _rows(session, model, **filters):
    rows = session.query(model).filter_by(**filters).all()
    rows += [obj for obj in session.new if isinstance(obj, model) and all(getattr(obj,k)==v for k,v in filters.items()) and obj not in rows]
    return rows


def legacy_participants(session, task_id):
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


def roster(session,task_id):return _rows(session,TaskRosterORM,task_id=task_id)


def participants(session,task_id):
    metas=_rows(session,TaskTrackerORM,task_id=task_id)
    if not metas or not metas[0].roster_initialized:return legacy_participants(session,task_id)
    ids={m.assignment_id for m in roster(session,task_id) if m.role=="assignee" and m.assignment_id}
    return [a for a in _rows(session,AssignmentORM,task_id=task_id) if a.assignment_id in ids]


def ensure_roster(session,task,meta):
    if meta.roster_initialized:return
    for assignment in legacy_participants(session,task.task_id):
        if not any(m.user_id==assignment.assignee_user_id for m in roster(session,task.task_id)):
            session.add(TaskRosterORM(task_id=task.task_id,user_id=assignment.assignee_user_id,role="assignee",
                assignment_id=assignment.assignment_id,created_at=None,updated_at=None))
    meta.roster_initialized=True


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
    item=TaskTrackerORM(task_id=task.task_id,status=status,legacy_mixed_statuses=mixed,assessment_revision=task.revision or 1,
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
            ensure_roster(session,task,meta)
            revisions=json.loads(meta.public_revisions_json or "{}")
            for assignment in _rows(session,AssignmentORM,task_id=task.task_id):revisions.setdefault(assignment.assignment_id,assignment.revision or 1)
            meta.public_revisions_json=json.dumps(revisions)
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
                ensure_roster(session,obj,metadata(session,obj))
                activity(session,obj,"task_created",obj.created_by_user_id,"Задача создана",at=obj.created_at,
                    changes=[dict(field="title",label="Название",before=None,after=obj.title),
                        dict(field="description",label="Описание",before=None,after=json.loads(obj.description_json or '{}').get('body','')),
                        dict(field="deadline_at",label="Срок",before=None,after=obj.deadline_at),
                        dict(field="status",label="Статус",before=None,after=metadata(session,obj).status)])
            elif isinstance(obj,AssignmentORM):
                task=session.get(TaskORM,obj.task_id)
                if task:
                    meta=metadata(session,task)
                    revisions=json.loads(meta.public_revisions_json or "{}")
                    revisions.setdefault(obj.assignment_id,obj.revision or 1);meta.public_revisions_json=json.dumps(revisions)
                    if meta.roster_initialized and not any(m.user_id==obj.assignee_user_id for m in roster(session,obj.task_id)):
                        session.add(TaskRosterORM(task_id=obj.task_id,user_id=obj.assignee_user_id,role="assignee",assignment_id=obj.assignment_id,created_at=None,updated_at=None))
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
            # Assignment outcomes/inputs are private accounting. No raw status is
            # reaggregated into public Task workflow after its migration baseline.


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
    public_revisions=json.loads(meta.public_revisions_json or "{}")
    season=session.get(SeasonORM,task.season_id)
    worker_caps={"start_assignment","resume_assignment","request_help","submit_result"}
    for assignment in result.assignments:
        visible_status=public_statuses.get(assignment.assignment_id,assignment.status)
        if assignment.assignment_id in current_ids and not result.legacy_status_conflict:visible_status=result.status
        assignment.status=visible_status
        assignment.revision=public_revisions.get(assignment.assignment_id,1)
        assignment.review_note=None
        assignment.capabilities=[c for c in assignment.capabilities if c not in worker_caps]
        if uid and season.state != "closed" and assignment.assignment_id in current_ids and assignment.assignee.user_id==uid and can_work(session,task,uid):
            if visible_status=="assigned":assignment.capabilities += ["start_assignment","submit_result","request_help"]
            if visible_status in {"in_progress","help_required","needs_revision"}:assignment.capabilities.append("submit_result")
            if visible_status in {"in_progress","needs_revision"}:assignment.capabilities.append("request_help")
            if visible_status=="help_required":assignment.capabilities.append("resume_assignment")
    result.assignees=[_user_to_ref_dc(session.get(UserORM,a.assignee_user_id)) for a in participants(session,task.task_id)]
    result.assignees=[user for user in result.assignees if user is not None]
    result.watchers=[_user_to_ref_dc(session.get(UserORM,m.user_id)) for m in roster(session,task.task_id) if m.role=="watcher"]
    result.watchers=[user for user in result.watchers if user is not None]
    result.created_by=_user_to_ref_dc(session.get(UserORM,task.created_by_user_id))
    result.created_at=task.created_at
    result.updated_at=meta.public_updated_at
    owner=session.get(BlockORM,task.scope_id) if task.scope_kind=="block" else session.get(SubeventORM,task.scope_id) if task.scope_kind=="subevent" else None
    result.scope_title=(owner.name if task.scope_kind=="block" else owner.title) if owner else queue.name if queue else "Команда"
    from membership import block_avatar_url
    from domain_models import BlockMetaORM
    block_meta = session.query(BlockMetaORM).filter_by(legacy_name=owner.name).first() if owner and task.scope_kind == "block" else None
    result.scope_avatar_url = block_avatar_url(session, block_meta)
    result.attachments=_file_refs(session,json.loads(meta.files_json or "[]"))
    rows=session.query(TaskSubmissionORM).filter_by(task_id=task.task_id).order_by(TaskSubmissionORM.submitted_at).all()
    result.submissions=[_submission_dict(session,row) for row in rows]
    if not rows:
        aids=[a.assignment_id for a in participants(session,task.task_id)]
        old=session.query(SubmissionORM).filter(SubmissionORM.assignment_id.in_(aids)).order_by(SubmissionORM.submitted_at).all() if aids else []
        result.submissions=[_submission_dict(session,row,False) for row in old]
    if uid:
        state=session.get(SeasonORM,task.season_id).state
        if db.can_read_task(uid,task,session):
            result.capabilities += ["change_task_status","start_task","resume_task","request_task_help","submit_task_result"]
        result.capabilities+=_task_caps(task,uid,{"review_task":"task.review","attach_task_file":"task.edit"})
        if can_edit_description(session,task,uid):result.capabilities.append("edit_task_description")
        if db.can_read_task(uid,task,session):
            member=next((m for m in roster(session,task.task_id) if m.user_id==uid),None)
            if not member or member.role!="assignee":result.capabilities.append("join_task")
            if not member or member.role!="assignee" or meta.status!="in_progress" or meta.legacy_mixed_statuses:result.capabilities.append("take_task")
            if not member or member.role not in {"assignee","watcher"}:result.capabilities.append("watch_task")
            if member and member.role=="watcher":result.capabilities.append("unwatch_task")
            if participants(session,task.task_id):result.capabilities.append("remove_task_assignee")
    from tracker_stage2 import enrich
    return enrich(session,task,result,uid)


def can_edit_public(session,task,uid):
    import access
    if not db.can_read_task(uid,task,session):return False
    state=session.get(SeasonORM,task.season_id).state
    if access.allowed(uid,"task.edit",task.scope_kind,task.scope_id,state=state):return True
    if state=="closed" and task.scope_kind!="queue":return False
    from task_queues import task_queue
    queue=task_queue(session,task)
    return task.created_by_user_id==uid or bool(queue and queue.owner_user_id==uid)


def can_edit_description(session,task,uid):
    if can_edit_public(session,task,uid):return True
    state=session.get(SeasonORM,task.season_id).state
    return (state!="closed" or task.scope_kind=="queue") and can_work(session,task,uid)


def can_edit_comment(session,comment,uid):
    task=session.get(TaskORM,comment.task_id)
    return bool(task and db.can_read_task(uid,task,session) and (comment.author_user_id==uid or task.created_by_user_id==uid or can_work(session,task,uid)))


def public_changes(session,event,uid):
    from task_queues import task_read,task_queue
    allowed={"title","description","deadline_at","status","comment","attachments","parent_task_id","assignees","watchers","season_id","task_type","priority","starts_at","checklist","links"}
    changes=[]
    for raw in json.loads(event.changes_json or "[]"):
        if raw.get("field") not in allowed:continue
        item={k:raw[k] for k in ("field","label","before","after") if k in raw}
        if item['field'] in {'assignees','watchers'}:
            item['label']='Исполнители' if item['field']=='assignees' else 'Наблюдатели'
            for side in ('before','after'):
                values=item.get(side)
                if not isinstance(values,list):continue
                refs=[]
                for value in values:
                    ref=_user_to_ref_dc(session.get(UserORM,int(value))) if str(value).isdigit() else None
                    refs.append(asdict(ref) if ref else dict(user_id=None,display_name="Недоступный участник",avatar_url=None))
                item[side]=[ref['display_name'] for ref in refs]
                item[side+'_users']=refs
        if item['field']=='parent_task_id':
            for side in ('before','after'):
                parent=session.get(TaskORM,item.get(side)) if item.get(side) else None
                if parent and task_read(session,parent,uid):
                    q=task_queue(session,parent);m=metadata(session,parent)
                    item[side]=(q.key+'-'+str(m.queue_number)) if q else 'TASK-'+str(m.task_number)
                elif item.get(side):item[side]='Недоступная задача'
        if item['field']=='season_id':
            for side in ('before','after'):
                season=session.get(SeasonORM,item.get(side)) if item.get(side) else None
                if item.get(side):item[side]=season.title if season else 'Недоступный сезон'
        if item['field']=='links':
            from tracker_stage2 import public_link_change
            for side in ('before','after'):
                item[side]=public_link_change(session,item.get(side),uid)
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


def change_status(task_id,uid,expected_revision,status,*,text="",links=None,file_ids=None,message=None,evaluation=None,review_note=None,reason=None,evaluations=None,legacy_assignment=None,require_result=False):
    """Public workflow is freely editable by readers and never writes accounting."""
    from file_access import check_attachments
    from notifications import emit
    if status not in STATUSES:raise InvalidInput("Unsupported task status")
    if evaluation is not None or evaluations or review_note is not None:raise InvalidInput("Accounting values require an authorized accounting command")
    links=links or [];file_ids=file_ids or []
    has_result=bool(text.strip() or links or file_ids)
    if require_result and not has_result:raise InvalidInput("A result, link or file is required")
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,uid);meta=metadata(session,task)
        if task.revision!=expected_revision:raise revision_conflict()
        if any(not link.startswith(("https://","http://")) for link in links):raise InvalidInput("Invalid result link")
        if file_ids:
            check_attachments(session,file_ids,"assignment" if legacy_assignment else "task",legacy_assignment or task_id,uid)
            if not legacy_assignment and any(session.get(FileRecordORM,fid).purpose!="submission" for fid in file_ids):raise Forbidden("Invalid result file purpose")
        old=meta.status;stamp=now()
        if status==old and not meta.legacy_mixed_statuses and not has_result and not message:return db.get_task(task_id,uid)
        if has_result:
            session.add(TaskSubmissionORM(submission_id="task-submission-"+str(uuid.uuid4()),task_id=task_id,submitted_at=stamp,
                created_by_user_id=uid,text_json=json.dumps({"format":"markdown","body":text}),links_json=json.dumps(links),files_json=json.dumps(file_ids)))
            if legacy_assignment:
                session.add(SubmissionORM(submission_id="submission-"+str(uuid.uuid4()),assignment_id=legacy_assignment,submitted_at=stamp,
                    created_by_user_id=uid,text_json=json.dumps({"format":"markdown","body":text}),links_json=json.dumps(links),files_json=json.dumps(file_ids)))
            activity(session,task,"result_submitted",uid,"Сдан результат задачи",at=stamp)
        if message and message.strip():
            session.add(CommentORM(comment_id="comment-"+str(uuid.uuid4()),task_id=task_id,author_user_id=uid,
                content_json=json.dumps({"format":"markdown","body":message}),history_json="[]",created_at=stamp))
        meta.status=status;meta.legacy_mixed_statuses=False
        public=json.loads(meta.public_statuses_json or "{}");revisions=json.loads(meta.public_revisions_json or "{}")
        for row in participants(session,task_id):
            public[row.assignment_id]=status;revisions[row.assignment_id]=revisions.get(row.assignment_id,1)+1
        meta.public_statuses_json=json.dumps(public);meta.public_revisions_json=json.dumps(revisions);task.revision+=1
        if old!=status:activity(session,task,"status_changed",uid,"Изменён статус задачи",at=stamp,before=old,after=status)
        recipients={m.user_id for m in roster(session,task_id) if m.role in {"assignee","watcher"}}
        kind="task_status_changed"
        if status=="help_required":
            from task_queues import task_queue
            queue=task_queue(session,task)
            recipients |= set(db.get_scope_leads(task.scope_kind,task.scope_id))|({queue.owner_user_id} if queue and queue.owner_user_id else set())
            kind="task_help_required"
        emit(session,[u for u in recipients if db.can_read_task(u,task,session)],kind,
            dict(task_id=task_id,title=task.title,status=status),"task-status:"+task_id+":"+str(task.revision),uid)
        session.commit()
        return db.get_task(task_id,uid)


def private_review(assignment_id,uid,expected_revision,status,*,evaluation=None,reason=None,review_note=None,**_ignored):
    from season_summaries import refresh
    with db.atomic():
      with db._session() as session:
        row=session.get(AssignmentORM,assignment_id)
        if not row:raise NotFound("Assignment not found")
        task=visible_task(session,row.task_id,uid)
        state=session.get(SeasonORM,task.season_id).state
        db.require_task_right(uid,"task.review",task,state,"Forbidden: cannot review task accounting","Forbidden: cannot review closed accounting")
        if task.scope_kind=="queue":raise InvalidInput("Independent tasks have no accounting source")
        if row.inputs_revision!=expected_revision:raise revision_conflict()
        note=reason or review_note or ""
        before=dict(status=row.status,hours=row.hours,evaluation=row.evaluation,effective_completed_at=row.effective_completed_at)
        if status in {"cancelled","not_completed","needs_revision"} and not note.strip():raise InvalidInput("Reason is required")
        if status in {"cancelled","not_completed"} and row.status not in ACTIVE:raise Conflict("Only unfinished private assignments may receive this outcome")
        if status=="accepted" and row.status in {"cancelled","not_completed"}:raise Conflict("Private accounting outcome cannot be reopened by acceptance")
        if status=="needs_revision" and row.status not in {"submitted","accepted"}:
            observed=session.query(TaskSubmissionORM).filter_by(task_id=task.task_id).first() or session.query(SubmissionORM).filter_by(assignment_id=assignment_id).first()
            if not observed:raise Conflict("Private assignment has no reviewable result")
        if status=="accepted":
            if evaluation not in (1,1.5):raise InvalidInput("Evaluation must be 1 or 1.5")
            if row.hours is None:raise InvalidInput("Hours must be set before acceptance")
            if not row.effective_completed_at:
                shared=session.query(TaskSubmissionORM).filter_by(task_id=task.task_id).order_by(TaskSubmissionORM.submitted_at.desc()).first()
                old=session.query(SubmissionORM).filter_by(assignment_id=assignment_id).order_by(SubmissionORM.submitted_at.desc()).first()
                observed=[s.submitted_at for s in (shared,old) if s]
                if not observed:raise InvalidInput("A real submission or explicit authorized completion date is required")
                row.effective_completed_at=max(observed)
        elif status=="not_completed":
            if evaluation not in (0,-1):raise InvalidInput("Evaluation must be 0 or -1")
        elif status not in {"cancelled","needs_revision"}:raise InvalidInput("Unsupported accounting outcome")
        row.status=status
        if status in {"accepted","not_completed"}:row.evaluation=evaluation
        elif status=="cancelled":row.evaluation=None
        row.review_note=note;row.revision+=1;row.inputs_revision+=1;row.updated_at=now()
        session.info.setdefault("manual_inputs_revision",set()).add(row.assignment_id)
        session.add(AuditLogORM(target_kind="assignment",target_id=assignment_id,changed_by_user_id=uid,reason=note or "Accounting decision",
            old_values_json=json.dumps(before),new_values_json=json.dumps(dict(status=status,hours=row.hours,evaluation=row.evaluation,effective_completed_at=row.effective_completed_at)),created_at=now()))
        try:
            _recalculate_assignment_contribution(session,row,task)
            refresh(session,task.season_id,uid,note or "Accounting decision")
            session.commit()
        finally:session.info.get("manual_inputs_revision",set()).discard(row.assignment_id)
        return next(a for a in db.get_task(task.task_id,uid).assignments if a.assignment_id==assignment_id)


def legacy_command(assignment_id,uid,expected_revision,status,*,required_source_status=None,**kwargs):
    if status in {"accepted","not_completed","cancelled","needs_revision"}:
        return private_review(assignment_id,uid,expected_revision,status,**kwargs)
    with db.atomic():
      with db._session() as session:
        row=session.get(AssignmentORM,assignment_id)
        if not row:raise NotFound("Assignment not found")
        task=session.get(TaskORM,row.task_id)
        if not task or not db.can_read_task(uid,task,session):raise Forbidden("Forbidden: task access ended")
        if row.assignee_user_id!=uid:raise Forbidden("Forbidden: own assignment required")
        if row.assignment_id not in {r.assignment_id for r in participants(session,row.task_id)}:raise Conflict("Assignment is no longer current")
        if session.get(SeasonORM,task.season_id).state=="closed":raise season_closed()
        meta=metadata(session,task);revision=json.loads(meta.public_revisions_json or "{}").get(row.assignment_id,1)
        if revision!=expected_revision:raise revision_conflict()
        if required_source_status and meta.status!=required_source_status:raise Conflict("Current public status does not permit this legacy command")
        result=change_status(task.task_id,uid,task.revision,status,legacy_assignment=assignment_id,require_result=status=="submitted",**kwargs)
        return next(a for a in result.assignments if a.assignment_id==assignment_id)


def task_page(uid,*,queue_id=None,season_id=None,scope_kind=None,scope_id=None,mine=False,status=None,q="",unfinished=False,overdue=False,assignee_user_id=None,task_type=None,priority=None,favorite=False,date_from=None,date_to=None,sort="deadline",order="asc",cursor=None,limit=20,converter):
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
        scope=scope_out(task.scope)
        if scope['kind'] in {"block","subevent"}:scopes[(scope['kind'],scope['id'])]=dict(**scope,title=task.scope_title)
        for person in task.assignees:
            if person.user_id is not None:assignees[person.user_id]=asdict(person)
    if mine:rows=[t for t in rows if any(a.user_id==uid for a in t.assignees)]
    if assignee_user_id is not None:rows=[t for t in rows if any(a.user_id==assignee_user_id for a in t.assignees)]
    if status:rows=[t for t in rows if t.status==status]
    if task_type:rows=[t for t in rows if t.task_type==task_type]
    if priority:rows=[t for t in rows if t.priority==priority]
    if favorite:rows=[t for t in rows if t.is_favorite]
    from tracker_stage2 import _time,_moment,PRIORITY_ORDER
    if date_from:date_from=_time(date_from)
    if date_to:date_to=_time(date_to)
    if date_from and date_to and _moment(date_from)>=_moment(date_to):raise InvalidInput("Date window must be increasing")
    if date_from:rows=[t for t in rows if _moment(t.deadline_at)>=_moment(date_from)]
    if date_to:rows=[t for t in rows if _moment(t.starts_at or t.deadline_at)<_moment(date_to)]
    if unfinished:rows=[t for t in rows if t.status in ACTIVE]
    if overdue:
        current=datetime.now(timezone.utc)
        rows=[t for t in rows if t.status in ACTIVE and datetime.fromisoformat(t.deadline_at.replace('Z','+00:00'))<current]
    needle=q.strip().casefold()
    if needle:rows=[t for t in rows if needle in t.title.casefold() or needle in t.task_key.casefold() or (t.legacy_task_key and needle in t.legacy_task_key.casefold())]
    field={'deadline':'deadline_at','updated':'updated_at','created':'created_at','priority':'priority','starts':'starts_at'}[sort]
    def key(item):
        if sort=='priority':value=str(PRIORITY_ORDER[item.priority])
        elif sort=='starts':value=item.starts_at or item.deadline_at
        else:value=getattr(item,field) or item.created_at or ""
        return value,item.task_id
    import base64,hashlib,binascii
    context=hashlib.sha256(json.dumps(dict(uid=uid,queue_id=queue_id,season_id=season_id,scope_kind=scope_kind,scope_id=internal_scope,mine=mine,status=status,q=needle,unfinished=unfinished,overdue=overdue,assignee_user_id=assignee_user_id,task_type=task_type,priority=priority,favorite=favorite,date_from=date_from,date_to=date_to,sort=sort,order=order,limit=limit),sort_keys=True).encode()).hexdigest()
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
