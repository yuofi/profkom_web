"""Public task participation is separate from immutable personal accounting outcomes."""
import json
import uuid
from database import db,TaskORM,TaskRosterORM,AssignmentORM,UserORM
from errors import Conflict,NotFound,revision_conflict
from tracker import visible_task,metadata,ensure_roster,roster,participants,activity,now


def _member(session,task,uid):
    return next((m for m in roster(session,task.task_id) if m.user_id==uid),None)


def _current_roles(session,task):
    return {role:[str(m.user_id) for m in roster(session,task.task_id) if m.role==role] for role in ('assignee','watcher')}


def change(task_id,actor,expected_revision,command,target_uid=None):
    with db.atomic():
      with db._session() as session:
        task=visible_task(session,task_id,actor);meta=metadata(session,task);ensure_roster(session,task,meta)
        if task.revision!=expected_revision:raise revision_conflict()
        uid=target_uid if command=='remove' else actor
        member=_member(session,task,uid);old_roles=_current_roles(session,task)
        if command=='remove' and (not member or member.role!='assignee'):raise NotFound('Current task assignee not found')
        if command=='unwatch' and (not member or member.role!='watcher'):raise Conflict('User is not a task watcher')
        if command=='watch' and member and member.role in {'watcher','assignee'}:return db.get_task(task_id,actor)
        if command=='join' and member and member.role=='assignee':return db.get_task(task_id,actor)
        if command=='take' and member and member.role=='assignee' and meta.status=='in_progress' and not meta.legacy_mixed_statuses:return db.get_task(task_id,actor)
        if not member:
            member=TaskRosterORM(task_id=task_id,user_id=uid,role='left',created_at=now())
            session.add(member)
        stamp=now();old_status=meta.status;session.info['tracker_batch']=True
        try:
            if command in {'join','take'}:
                assignment=session.get(AssignmentORM,member.assignment_id) if member.assignment_id else None
                if not assignment:
                    # Reuse the most recent personal ledger row; never duplicate a past credit.
                    assignment=session.query(AssignmentORM).filter_by(task_id=task_id,assignee_user_id=uid).order_by(AssignmentORM.created_at.desc(),AssignmentORM.assignment_id.desc()).first()
                if not assignment:
                    assignment=AssignmentORM(assignment_id='assignment-'+str(uuid.uuid4()),task_id=task_id,assignee_user_id=uid,
                        status='assigned',hours=0,revision=1,created_at=stamp)
                    session.add(assignment)
                member.assignment_id=assignment.assignment_id;member.role='assignee'
                if command=='join':
                    revisions=json.loads(meta.public_revisions_json or '{}');revisions[assignment.assignment_id]=revisions.get(assignment.assignment_id,0)+1;meta.public_revisions_json=json.dumps(revisions)
                    public=json.loads(meta.public_statuses_json or '{}');public[assignment.assignment_id]=meta.status;meta.public_statuses_json=json.dumps(public)
            elif command=='remove':
                member.role='watcher'
                assignment=session.get(AssignmentORM,member.assignment_id) if member.assignment_id else None
                if assignment:
                    revisions=json.loads(meta.public_revisions_json or '{}');revisions[assignment.assignment_id]=revisions.get(assignment.assignment_id,1)+1;meta.public_revisions_json=json.dumps(revisions)
                    public=json.loads(meta.public_statuses_json or '{}');public[assignment.assignment_id]='cancelled';meta.public_statuses_json=json.dumps(public)
            elif command=='watch':member.role='watcher'
            elif command=='unwatch':member.role='left'
            else:raise Conflict('Unknown roster command')
            if command=='take':
                # One public command: joining never resets an existing private ledger row.
                meta.status='in_progress';meta.legacy_mixed_statuses=False
                public=json.loads(meta.public_statuses_json or '{}');revisions=json.loads(meta.public_revisions_json or '{}')
                for assignment in participants(session,task_id):
                    public[assignment.assignment_id]='in_progress';revisions[assignment.assignment_id]=revisions.get(assignment.assignment_id,0)+1
                meta.public_statuses_json=json.dumps(public);meta.public_revisions_json=json.dumps(revisions)
            member.updated_at=stamp;task.revision+=1
            after_roles=_current_roles(session,task)
            changes=[dict(field='assignees' if role=='assignee' else 'watchers',label='Исполнители (ID)' if role=='assignee' else 'Наблюдатели (ID)',before=old_roles[role],after=after_roles[role]) for role in old_roles if old_roles[role]!=after_roles[role]]
            if changes:activity(session,task,'roster_changed',actor,'Изменён состав участников задачи',at=stamp,changes=changes)
            if command=='take' and old_status!='in_progress':activity(session,task,'status_changed',actor,'Изменён статус задачи',at=stamp,before=old_status,after='in_progress')
            from notifications import emit
            recipients={m.user_id for m in roster(session,task_id) if m.role in {"assignee","watcher"}}|{task.created_by_user_id}
            readers=[u for u in recipients if db.can_read_task(u,task,session)]
            if changes:emit(session,readers,"task_roster_changed",
                dict(task_id=task_id,title=task.title),"task-roster:"+task_id+":"+str(task.revision),actor)
            if command=="take" and old_status!="in_progress":emit(session,readers,"task_status_changed",
                dict(task_id=task_id,title=task.title,status="in_progress"),"task-status:"+task_id+":"+str(task.revision),actor)
            session.commit()
        finally:session.info.pop('tracker_batch',None)
        return db.get_task(task_id,actor)
