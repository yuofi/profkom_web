"""In-transaction outbox for internal notifications. No external delivery."""

import json, uuid
from database import db, UserORM, NotificationORM, AssignmentORM
from registration import now


def emit(session, recipients, kind, payload, event_key, actor=None):
    for uid in set(recipients):
        u = session.get(UserORM, uid)
        if not u or u.account_state != "active" or u.banned or uid == actor:
            continue
        if (
            session.query(NotificationORM)
            .filter_by(user_id=uid, event_key=event_key)
            .first()
        ):
            continue
        session.add(
            NotificationORM(
                notification_id=str(uuid.uuid4()),
                user_id=uid,
                kind=kind,
                payload_json=json.dumps(payload, ensure_ascii=False),
                event_key=event_key,
                is_read=False,
                created_at=now(),
            )
        )


def report_published(session, report, actor):
    recipients = [
        u.user_id
        for u in session.query(UserORM)
        if db.can_read_report(u.user_id, report, session)
    ]
    emit(
        session,
        recipients,
        "report_published",
        dict(report_id=report.report_id, title=report.title),
        "report:" + report.report_id + ":" + str(report.published_version),
        actor,
    )


def meeting_changed(session, meeting, actor):
    from workspace import meeting_read

    recipients = [
        u.user_id for u in session.query(UserORM) if meeting_read(u.user_id, meeting)
    ]
    emit(
        session,
        recipients,
        "meeting_changed",
        dict(
            meeting_id=meeting.meeting_id,
            owner_kind=meeting.owner_kind,
            owner_id=meeting.owner_id,
            title=meeting.title,
        ),
        "meeting:" + meeting.meeting_id + ":" + str(meeting.revision),
        actor,
    )


def comment_added(session, comment, task, actor):
    from tracker import participants,roster
    recipients = {
        a.assignee_user_id for a in participants(session,task.task_id)
    } | {m.user_id for m in roster(session,task.task_id) if m.role=="watcher"} | set(db.get_scope_leads(task.scope_kind, task.scope_id))
    emit(
        session,
        [
            uid
            for uid in recipients
            if db.can_read_task(uid,task,session)
        ],
        "task_comment",
        dict(task_id=task.task_id, title=task.title),
        "comment:" + comment.comment_id,
        actor,
    )


def registration_submitted(session, application):
    import access

    recipients = [u.user_id for u in session.query(UserORM) if access.allowed(u.user_id, "registration.review")]
    emit(
        session,
        recipients,
        "registration_submitted",
        {"registration_user_id": application.user_id},
        "registration:"
        + str(application.user_id)
        + ":"
        + str(application.total_submissions),
    )
