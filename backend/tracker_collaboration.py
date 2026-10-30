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
from pydantic import Field
from validation import Command
from auth import get_current_user
from models import User
from database import db, TaskORM, CommentORM, UserORM, _user_to_ref_dc
from tracker_collaboration_models import TaskMentionRequestORM, TaskAccessGrantORM
from errors import Forbidden, InvalidInput, NotFound, Conflict, revision_conflict
from read_context import cached


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
                UserORM.user_id.in_(ids[start:start+400]),UserORM.account_state=='active',UserORM.banned.is_(False)).all()
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


def _managers(session,task):
    from task_queues import task_queue,active
    queue=task_queue(session,task)
    return {uid for uid in (task.created_by_user_id,queue.owner_user_id if queue else None)
            if uid and active(session,uid) and db.can_read_task(uid,task,session)}


def _task_key(session,task):
    from task_queues import task_queue
    from tracker import metadata
    queue=task_queue(session,task);meta=metadata(session,task)
    return queue.key+"-"+str(meta.queue_number) if queue else "TASK-"+str(meta.task_number)


def _projection(session,row,uid):
    target=_user_to_ref_dc(session.get(UserORM,row.target_user_id));requester=_user_to_ref_dc(session.get(UserORM,row.requested_by_user_id))
    task=session.get(TaskORM,row.task_id)
    caps=[]
    if task and uid in _managers(session,task):
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
        if uid not in _managers(session,task):return dict(items=[],next_cursor=None)
        rows=session.query(TaskMentionRequestORM).filter_by(task_id=task_id).all()
        page=cursor_page(rows,lambda row:(row.created_at,row.request_id),cursor,descending=True)
        return dict(items=[_projection(session,row,uid) for row in page.items],next_cursor=page.next_cursor)


def decide(task_id,request_id,uid,expected_revision,approve):
    from tracker import visible_task,now,activity
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,uid)
        if uid not in _managers(session,task):raise Forbidden("Only task author or queue owner can approve mentions")
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
        if uid not in _managers(session,task):raise Forbidden("Only task author or queue owner can revoke access")
        row=session.get(TaskAccessGrantORM,(task_id,target_uid))
        if not row or not row.active:raise NotFound("Task grant not found")
        if row.source=="control":raise Conflict("Control access is managed automatically","control_epic_managed")
        row.active=False;row.revoked_at=now()
        activity(session,task,"task_access_revoked",uid,"Отозван доступ к задаче")
        session.flush()
        return dict(revoked=True)


def candidates(task_id,uid):
    from tracker import visible_task
    from task_queues import active
    with db._session() as session:
        visible_task(session,task_id,uid)
        return dict(items=[asdict(ref) for row in session.query(UserORM).options(selectinload(UserORM.contact)).order_by(UserORM.user_id)
            if active(session,row.user_id) and (ref:=_user_to_ref_dc(row))],next_cursor=None)


class MentionDecisionIn(Command):
    expected_revision:int=Field(ge=1)


class DescriptionChecklistIn(Command):
    expected_revision:int=Field(ge=1)
    body:str=Field(max_length=1000000)


class QueueCancelIn(Command):
    expected_revision:int=Field(ge=1)


def register_routes(router):
    @router.post("/tasks/{task_id}/description-checklist")
    def description_checklist(task_id:str,payload:DescriptionChecklistIn,cur:User=Depends(get_current_user)):
        from main import _to_task_public_out
        return _to_task_public_out(toggle_description_checklist(task_id,cur.user_id,payload.expected_revision,payload.body))

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


def toggle_description_checklist(task_id,uid,expected_revision,body):
    """Reader command changes only checkbox marker bytes, never description text."""
    import re
    from tracker import visible_task,activity,is_control_task
    def neutral(value):
        # Fenced examples are literal code, not interactive checklist content.
        output=[];fence=None
        for line in value.splitlines(keepends=True):
            marker=re.match(r'^ {0,3}(`{3,}|~{3,})',line)
            if marker:
                token=marker.group(1)
                if fence is None:fence=token
                elif token[0]==fence[0] and len(token)>=len(fence):fence=None
                output.append(line);continue
            if fence is None:
                line=re.sub(r'^( {0,3}(?:[-+*]|\d+[.)])[ \t]+\[)[ xX](\])',r'\1 \2',line,count=1)
            output.append(line)
        return ''.join(output)
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,uid)
        if task.revision!=expected_revision:raise revision_conflict()
        if is_control_task(session,task_id):raise Forbidden('Control epic content is managed automatically')
        content=json.loads(task.description_json or '{}');before=content.get('body','')
        if neutral(before)!=neutral(body):raise Forbidden('Only checklist marks may be changed','checklist_only')
        if before!=body:
            content['body']=body;task.description_json=json.dumps(content,ensure_ascii=False);task.revision+=1
            activity(session,task,'task_updated',uid,'Изменены отметки чеклиста',changes=[dict(field='description',label='Описание',before=before,after=body)])
        session.flush()
        return db.get_task(task_id,uid)
