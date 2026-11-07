"""Task mentions notify readers and request approval before opening a private task.

The author or queue owner may approve. A grant never confers queue membership or
private KKR rights. Callers own the surrounding command transaction.
"""
from dataclasses import asdict
import json
import re
import uuid
from fastapi import Depends
from sqlalchemy.orm import selectinload
from typing import Optional
from pydantic import Field, model_validator
from validation import Command
from auth import get_current_user
from models import User
from database import db, TaskORM, CommentORM, UserORM, _user_to_ref_dc
from tracker_collaboration_models import TaskMentionRequestORM, TaskAccessGrantORM
from errors import Forbidden, InvalidInput, NotFound, Conflict, revision_conflict
from read_context import cached
from service_account import visible


def _comment_profile_ids(body):
    """Recognize only explicit local profile links in a conservative prose subset.

    This is display enrichment, not a mention command or an access grant. Code,
    images, foreign addresses and unavailable identities never supply a chip.
    """
    prose=[]
    fence=None
    for line in body.splitlines(keepends=True):
        marker=re.match(r"^ {0,3}(`{3,}|~{3,})",line)
        if fence:
            if marker and marker[1][0]==fence[0] and len(marker[1])>=len(fence) and not line[marker.end():].strip():
                fence=None
            continue
        if marker:
            fence=marker[1]
            continue
        if line.startswith(("    ","\t")):
            continue
        prose.append(line)
    source=re.sub(r"(`+)[\s\S]*?\1(?!`)","",''.join(prose))
    return list(dict.fromkeys(int(match[1]) for match in re.finditer(
        r"(?<![!\\])\[(?:\\.|[^\]\\\n])*\]\(/contacts/([1-9][0-9]*)\)",source)
        if len(match[1])<=18))[:100]


def comment_mention_refs(comments):
    """Batch safe identity chips for already-authorized comment DTOs.

    Looking up a link never notifies its target and never opens task/queue access.
    Archived, banned, missing and anonymized identities are omitted; the renderer
    replaces their local link with a non-interactive unavailable-person chip.
    """
    by_comment={comment.comment_id:_comment_profile_ids(comment.content.body) for comment in comments}
    ids=sorted({uid for values in by_comment.values() for uid in values})
    refs={}
    with db._session() as session:
        from directory import avatar_urls
        for start in range(0,len(ids),400):
            rows=session.query(UserORM).options(selectinload(UserORM.contact)).filter(
                UserORM.user_id.in_(ids[start:start+400]),UserORM.account_state=='active',UserORM.banned.is_(False),
                visible()).all()
            avatars=avatar_urls(session,rows)
            for user in rows:
                contact=user.contact
                name=' '.join(part for part in (contact.surname,contact.name,contact.patronymic) if part).strip() if contact else ''
                name=name or (contact.kkr_name if contact else None) or f'Участник {user.user_id}'
                refs[user.user_id]=dict(user_id=user.user_id,display_name=name,avatar_url=avatars[user.user_id])
    return {comment_id:[refs[uid] for uid in values if uid in refs] for comment_id,values in by_comment.items()}


def has_task_grant(session, task_id, uid):
    from task_queues import active
    if not uid or not active(session,uid):return False
    def check():
        row=session.get(TaskAccessGrantORM,(task_id,uid))
        if not row or not row.active:return False
        from tracker import is_control_task
        if row.source=="control" or is_control_task(session,task_id):
            from domain_models import KkrControlEpicORM
            import access
            control=session.query(KkrControlEpicORM).filter_by(task_id=task_id).first()
            if not control:return False
            sid=control.source_id
            if control.source_kind=="block":
                from membership import legacy_name
                sid=legacy_name(sid)
            return access.allowed(uid,"queue.create",control.source_kind,sid)
        return True
    return cached(session,"task.single_grant",(task_id,uid),check,copy_result=False)


def grant_task_access(session, task_id, user_id, actor_uid, source="mention"):
    """Trusted command helper; public callers must establish approval authority."""
    from tracker import now
    from task_queues import active
    if not active(session,user_id):raise InvalidInput("Mentioned user must be active and approved")
    from service_account import refuse
    refuse(session,user_id)  # it reads every task already and is never granted one
    row=session.get(TaskAccessGrantORM,(task_id,user_id))
    row=row or next((item for item in session.new if isinstance(item,TaskAccessGrantORM) and item.task_id==task_id and item.user_id==user_id),None)
    if row and row.active and row.source==source:return row
    if not row:
        row=TaskAccessGrantORM(task_id=task_id,user_id=user_id);session.add(row)
    row.active=True;row.source=source;row.granted_at=now();row.granted_by_user_id=actor_uid;row.revoked_at=None
    return row


def approve_assignment_access(session,task,target_uid,actor_uid):
    """Explicit assignment by an approver is also an auditable access approval."""
    grant=grant_task_access(session,task.task_id,target_uid,actor_uid,source="assignment")
    row=TaskMentionRequestORM(request_id="task-access-"+str(uuid.uuid4()),task_id=task.task_id,
        comment_id=None,target_user_id=target_uid,requested_by_user_id=actor_uid,status="approved",
        created_at=grant.granted_at,decided_at=grant.granted_at,decided_by_user_id=actor_uid,revision=1)
    session.add(row)
    return grant


def _managers(session,task,facts=None):
    from task_queues import task_queue,active
    from tracker import _facts_for
    from support import is_support_queue,is_staff
    facts=_facts_for(facts,task)
    queue=task_queue(session,task)
    author=task.created_by_user_id
    # A support ticket's access is shared by support staff, not by its author (GL-22).
    if author and queue and is_support_queue(session,queue) and not cached(
            session,"support.is_staff",author,lambda:is_staff(session,author),copy_result=False):author=None
    return {uid for uid in (author,queue.owner_user_id if queue else None)
            if uid and active(session,uid) and (facts.readable(uid) if facts else db.can_read_task(uid,task,session))}


def is_manager(session,task,uid,facts=None):
    """A task access manager; the service account manages every task it reads (owner, 2026-11-08)."""
    if uid in _managers(session,task,facts):return True
    from service_account import is_service_id
    from tracker import _facts_for
    facts=_facts_for(facts,task)
    return is_service_id(uid) and (facts.readable(uid) if facts else db.can_read_task(uid,task,session))


def _require_manager(session,task,uid,message):
    if is_manager(session,task,uid):return
    from task_queues import task_queue
    from support import is_support_queue
    queue=task_queue(session,task)
    # A support ticket's own author is told who shares it (GL-22).
    if uid==task.created_by_user_id and queue and is_support_queue(session,queue):
        raise Forbidden("Support ticket sharing is managed by support staff")
    raise Forbidden(message)


def _task_key(session,task):
    from task_queues import task_queue
    from tracker import metadata
    queue=task_queue(session,task);meta=metadata(session,task)
    return queue.key+"-"+str(meta.queue_number) if queue else "TASK-"+str(meta.task_number)


def _projection(session,row,uid):
    target=_user_to_ref_dc(session.get(UserORM,row.target_user_id));requester=_user_to_ref_dc(session.get(UserORM,row.requested_by_user_id))
    task=session.get(TaskORM,row.task_id)
    caps=[]
    if task and is_manager(session,task,uid):
        if row.status=="pending":
            from tracker import is_control_task
            caps=["reject_task_mention"] if is_control_task(session,row.task_id) else ["approve_task_mention","reject_task_mention"]
        grant=session.get(TaskAccessGrantORM,(row.task_id,row.target_user_id))
        if row.status=="approved" and grant and grant.active and grant.source!="control" and row.decided_at==grant.granted_at:
            caps.append("revoke_task_access")
    return dict(request_id=row.request_id,task_id=row.task_id,task_key=_task_key(session,task) if task else None,
        target=asdict(target) if target else None,requested_by=asdict(requester) if requester else None,
        comment_id=row.comment_id,status=row.status,created_at=row.created_at,revision=row.revision,capabilities=caps)


def _notify_mention(session,task,target,actor,comment_id,event_key):
    from notifications import emit
    emit(session,[target],"task_mention",dict(task_id=task.task_id,title=task.title,comment_id=comment_id),event_key,actor)


def _sync(session,task,actor,user_ids,comment_id):
    from task_queues import active
    from tracker import now
    from notifications import emit
    from support import is_support_queue
    from task_queues import task_queue
    if not db.can_read_task(actor,task,session):raise NotFound("Task not found")
    ids=list(dict.fromkeys(user_ids))
    if len(ids)>100 or any(not isinstance(uid,int) or isinstance(uid,bool) or uid<=0 or not active(session,uid) for uid in ids):
        raise InvalidInput("Mentioned users must be active approved accounts")
    from service_account import refuse_all
    refuse_all(session,ids)  # never mentioned (owner, 2026-11-08)
    from tracker import is_control_task
    if is_control_task(session,task.task_id) and any(not db.can_read_task(uid,task,session) for uid in ids):
        raise Conflict("Control epic access follows current leadership roles","control_epic_managed")
    result=[]
    for uid in ids:
        key="task-mention:"+str(comment_id)+":"+str(uid)
        if db.can_read_task(uid,task,session):
            _notify_mention(session,task,uid,actor,comment_id,key)
            continue
        queue=task_queue(session,task)
        if queue and is_support_queue(session,queue):
            raise Forbidden("Support ticket sharing is managed by support staff")
        row=session.query(TaskMentionRequestORM).filter_by(task_id=task.task_id,target_user_id=uid,status="pending").first()
        row=row or next((item for item in session.new if isinstance(item,TaskMentionRequestORM) and item.task_id==task.task_id and item.target_user_id==uid and item.status=="pending"),None)
        if not row:
            row=TaskMentionRequestORM(request_id="task-mention-"+str(uuid.uuid4()),task_id=task.task_id,
                comment_id=comment_id,target_user_id=uid,requested_by_user_id=actor,status="pending",created_at=now(),revision=1)
            session.add(row)
            emit(session,sorted(_managers(session,task)),"task_mention_access_request",
                dict(task_id=task.task_id,title=task.title,request_id=row.request_id),"task-mention-request:"+row.request_id,actor)
        result.append(_projection(session,row,actor))
    return result


def sync_comment_mentions(comment_id,actor_uid,user_ids):
    with db._session() as session:
        comment=session.get(CommentORM,comment_id)
        if not comment:raise NotFound("Comment not found")
        task=session.get(TaskORM,comment.task_id)
        if not task:raise NotFound("Task not found")
        return _sync(session,task,actor_uid,user_ids,comment_id)


def add_mention_comment(session,task,actor_uid,body,mention_user_ids):
    """Use ordinary comment/mention notifications for explicit bulk reminders."""
    from tracker import now
    if not body.strip():raise InvalidInput("Comment text is required")
    if not db.can_read_task(actor_uid,task,session):raise NotFound("Task not found")
    comment=CommentORM(comment_id="comment-"+str(uuid.uuid4()),task_id=task.task_id,author_user_id=actor_uid,
        content_json=json.dumps(dict(format="markdown",body=body)),history_json="[]",created_at=now())
    session.add(comment);session.flush()
    _sync(session,task,actor_uid,mention_user_ids,comment.comment_id)
    return comment


def list_requests(task_id,uid,cursor=None):
    from tracker import visible_task
    from api_contract import cursor_page
    with db._session() as session:
        task=visible_task(session,task_id,uid)
        if not is_manager(session,task,uid):return dict(items=[],next_cursor=None)
        rows=session.query(TaskMentionRequestORM).filter_by(task_id=task_id).all()
        page=cursor_page(rows,lambda row:(row.created_at,row.request_id),cursor,descending=True)
        return dict(items=[_projection(session,row,uid) for row in page.items],next_cursor=page.next_cursor)


def decide(task_id,request_id,uid,expected_revision,approve):
    from tracker import visible_task,now,activity
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,uid)
        _require_manager(session,task,uid,"Only task author or queue owner can approve mentions")
        row=session.get(TaskMentionRequestORM,request_id)
        if not row or row.task_id!=task_id:raise NotFound("Task access request not found")
        if row.revision!=expected_revision:raise revision_conflict()
        if row.status!="pending":raise Conflict("Task access request has already been decided")
        from tracker import is_control_task
        if approve and is_control_task(session,task_id):raise Conflict("Control epic access follows current leadership roles","control_epic_managed")
        row.status="approved" if approve else "rejected";row.decided_at=now();row.decided_by_user_id=uid;row.revision+=1
        if approve:
            grant=grant_task_access(session,task_id,row.target_user_id,uid)
            grant.granted_at=row.decided_at
            _notify_mention(session,task,row.target_user_id,row.requested_by_user_id,row.comment_id,"task-mention-approved:"+row.request_id)
        activity(session,task,"task_access_decided",uid,"Согласован призыв участника" if approve else "Призыв отклонён")
        session.flush()
        return _projection(session,row,uid)


def revoke(task_id,target_uid,uid):
    from tracker import visible_task,now,activity
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,uid)
        _require_manager(session,task,uid,"Only task author or queue owner can revoke access")
        row=session.get(TaskAccessGrantORM,(task_id,target_uid))
        if not row or not row.active:raise NotFound("Task grant not found")
        if row.source=="control":raise Conflict("Control access is managed automatically","control_epic_managed")
        row.active=False;row.revoked_at=now()
        activity(session,task,"task_access_revoked",uid,"Отозван доступ к задаче")
        session.flush()
        return dict(revoked=True)


def candidates(task_id,uid):
    """Active people for mentions and assignment. can_assign: the person already reads
    the task, or the actor approves access (author/queue owner). Support tickets and
    control epics never share access by a mention, so only their readers are offered."""
    from tracker import visible_task,is_control_task
    from task_queues import active,task_readers,task_queue
    from support import is_support_queue
    with db._session() as session:
        task=visible_task(session,task_id,uid)
        rows=[row for row in session.query(UserORM).options(selectinload(UserORM.contact)).filter(visible()).order_by(UserORM.user_id) if active(session,row.user_id)]
        readers=task_readers(session,task,[row.user_id for row in rows])
        queue=task_queue(session,task)
        closed=bool(queue and is_support_queue(session,queue)) or is_control_task(session,task.task_id)
        approver=not closed and is_manager(session,task,uid)
        from database import _user_ref_with_avatar
        from directory import avatar_urls
        rows=[row for row in rows if not closed or row.user_id in readers];avatars=avatar_urls(session,rows)
        return dict(items=[dict(asdict(ref),can_assign=row.user_id in readers or approver) for row in rows
            if (ref:=_user_ref_with_avatar(row,avatars[row.user_id]))],next_cursor=None)


class MentionDecisionIn(Command):
    expected_revision:int=Field(ge=1)


class DescriptionChecklistIn(Command):
    expected_revision:int=Field(ge=1)
    body:Optional[str]=Field(None,max_length=1000000)
    offset:Optional[int]=Field(None,ge=0,le=2000000,description="Position of the [ ]/[x] mark in the description, in UTF-16 code units (a JavaScript string index).")
    checked:Optional[bool]=Field(None,strict=True)

    @model_validator(mode="after")
    def one_form(self):
        if (self.body is None)==(self.offset is None) or (self.offset is None)!=(self.checked is None):
            raise ValueError("Send either the marked body or offset with checked")
        return self


class QueueCancelIn(Command):
    expected_revision:int=Field(ge=1)


def register_routes(router):
    @router.post("/tasks/{task_id}/description-checklist")
    def description_checklist(task_id:str,payload:DescriptionChecklistIn,cur:User=Depends(get_current_user)):
        from main import _to_task_public_out
        return _to_task_public_out(toggle_description_checklist(task_id,cur.user_id,payload.expected_revision,payload.body,payload.offset,payload.checked))

    @router.post("/tasks/{task_id}/assignees/{user_id}/add")
    def assign_task_person(task_id:str,user_id:int,payload:MentionDecisionIn,cur:User=Depends(get_current_user)):
        from task_roster import change
        from main import _to_task_public_out
        return _to_task_public_out(change(task_id,cur.user_id,payload.expected_revision,"assign",user_id))

    @router.post("/tasks/{task_id}/watchers/{user_id}/remove")
    def remove_task_watcher(task_id:str,user_id:int,payload:MentionDecisionIn,cur:User=Depends(get_current_user)):
        from task_roster import change
        from main import _to_task_public_out
        return _to_task_public_out(change(task_id,cur.user_id,payload.expected_revision,"remove_watcher",user_id))

    @router.get("/tasks/{task_id}/mention-candidates")
    def mention_candidates(task_id:str,cur:User=Depends(get_current_user)):
        return candidates(task_id,cur.user_id)

    @router.get("/tasks/{task_id}/mentions")
    def mention_requests(task_id:str,cursor:str|None=None,cur:User=Depends(get_current_user)):
        return list_requests(task_id,cur.user_id,cursor)

    @router.post("/tasks/{task_id}/mentions/{request_id}/approve")
    def approve_mention(task_id:str,request_id:str,payload:MentionDecisionIn,cur:User=Depends(get_current_user)):
        return decide(task_id,request_id,cur.user_id,payload.expected_revision,True)

    @router.post("/tasks/{task_id}/mentions/{request_id}/reject")
    def reject_mention(task_id:str,request_id:str,payload:MentionDecisionIn,cur:User=Depends(get_current_user)):
        return decide(task_id,request_id,cur.user_id,payload.expected_revision,False)

    @router.post("/tasks/{task_id}/access/{user_id}/revoke")
    def revoke_mention_access(task_id:str,user_id:int,cur:User=Depends(get_current_user)):
        return revoke(task_id,user_id,cur.user_id)

    @router.post("/task-queues/{queue_id}/access-requests/{request_id}/cancel")
    def cancel_queue_access(queue_id:str,request_id:str,payload:QueueCancelIn,cur:User=Depends(get_current_user)):
        from task_queues import cancel_request
        return cancel_request(queue_id,request_id,cur.user_id,payload.expected_revision)


def toggle_description_checklist(task_id,uid,expected_revision,body=None,offset=None,checked=None):
    """Reader command changes only checkbox marker bytes, never description text.

    The client names one marker by its source offset in UTF-16 code units, as a
    browser indexes the text (or, compatibly, sends the whole body); either way only
    bytes of task markers outside code may change.
    """
    from tracker import visible_task,activity,is_control_task
    from markdown_checklist import checklist_marker_offsets,checklist_marker_utf16_offsets
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,uid)
        if task.revision!=expected_revision:raise revision_conflict()
        if is_control_task(session,task_id):raise Forbidden('Control epic content is managed automatically')
        content=json.loads(task.description_json or '{}');before=content.get('body','')
        if offset is not None:
            index=checklist_marker_utf16_offsets(before).get(offset)
            if index is None:raise Forbidden('Only checklist marks may be changed','checklist_only')
            body=before if (before[index]!=' ')==checked else before[:index]+('x' if checked else ' ')+before[index+1:]
        else:
            markers=checklist_marker_offsets(before)
            if len(body)!=len(before) or any(old!=new and (index not in markers or new not in ' xX') for index,(old,new) in enumerate(zip(before,body))):
                raise Forbidden('Only checklist marks may be changed','checklist_only')
        if before!=body:
            content['body']=body;task.description_json=json.dumps(content,ensure_ascii=False);task.revision+=1
            activity(session,task,'task_updated',uid,'Изменены отметки чеклиста',changes=[dict(field='description',label='Описание',before=before,after=body)])
        session.flush()
        return db.get_task(task_id,uid)
