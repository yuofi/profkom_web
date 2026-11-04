"""In-transaction outbox for internal notifications. Outside the site only the VK channel is
connected, through the bot's queue (profile_features.collect_delivery_event, BOT_API.md)."""

import json, uuid
from database import db, UserORM, NotificationORM, AssignmentORM
from registration import now


def _chunks(values, size=500):
    return (values[index:index + size] for index in range(0, len(values), size))


def recipients_among(session, candidates, decide):
    """Users passing ``decide``, listed as a scan of every user lists them.

    ``candidates`` (a superset such as access.holders) only bounds the scan; the
    existing ACL ``decide`` still makes every decision. None scans every user.
    """
    if candidates is None:
        return [u.user_id for u in session.query(UserORM) if decide(u.user_id)]
    ids = sorted(uid for uid in candidates if isinstance(uid, int))
    present = set()
    for batch in _chunks(ids):
        present.update(u.user_id for u in session.query(UserORM).filter(UserORM.user_id.in_(batch)))
    return [uid for uid in ids if uid in present and decide(uid)]


def _recipient_rows(session, targets, kind, event_key):
    """The recipients' accounts, existing notifications of this event and delivery
    preferences in one read each (the per-recipient lookups emit used to make)."""
    from profile_features import delivery_category
    from profile_features_models import NotificationPreferenceORM
    ids = sorted(uid for uid in targets if isinstance(uid, int))
    users, existing = {}, set()
    preferences = {} if delivery_category(kind) is not None else None
    for batch in _chunks(ids):
        users.update((u.user_id, u) for u in session.query(UserORM).filter(UserORM.user_id.in_(batch)))
        existing.update(row[0] for row in session.query(NotificationORM.user_id).filter(
            NotificationORM.event_key == event_key, NotificationORM.user_id.in_(batch)))
        if preferences is not None:
            preferences.update((row.user_id, row) for row in session.query(NotificationPreferenceORM).filter(
                NotificationPreferenceORM.user_id.in_(batch)))
    return users, existing, preferences


def emit(session, recipients, kind, payload, event_key, actor=None):
    targets = set(recipients)
    users, existing, preferences = _recipient_rows(session, targets, kind, event_key)
    for uid in targets:
        u = users.get(uid) if isinstance(uid, int) else session.get(UserORM, uid)
        if not u or u.account_state != "active" or u.banned or uid == actor:
            continue
        if (uid in existing if isinstance(uid, int) else
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
        from profile_features import collect_delivery_event
        collect_delivery_event(session, uid, kind, payload, event_key,
                               preferences=preferences if isinstance(uid, int) else None, user=u)


def emit_everyone(session, kind, payload, event_key, actor=None):
    """emit to every active account (not archived, not banned) but the actor, in two
    statements however many there are: one SELECT of the accounts without this event yet and
    one INSERT (executemany), no ORM rows. For kinds without a delivery category only (the
    stage 4 broadcast): they have no outbox row. Returns how many were notified."""
    from profile_features import delivery_category
    from sqlalchemy import exists, insert, select
    assert delivery_category(kind) is None, kind
    ids = session.execute(select(UserORM.user_id).where(
        UserORM.account_state == "active", UserORM.banned == False,  # noqa: E712
        UserORM.user_id != (actor if isinstance(actor, int) else -1),
        ~exists().where(NotificationORM.user_id == UserORM.user_id, NotificationORM.event_key == event_key),
    ).order_by(UserORM.user_id)).scalars().all()
    if ids:
        body, created = json.dumps(payload, ensure_ascii=False), now()
        session.execute(insert(NotificationORM.__table__), [
            dict(notification_id=str(uuid.uuid4()), user_id=uid, kind=kind, payload_json=body, event_key=event_key,
                 is_read=False, read_at=None, created_at=created) for uid in ids])
    return len(ids)


def report_published(session, report, actor):
    from report_access import reader_candidates
    recipients = recipients_among(session, reader_candidates(session, report),
                                  lambda uid: db.can_read_report(uid, report, session))
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
    import access

    candidates = access.holders([f"{meeting.owner_kind}.meeting.view"], meeting.owner_kind, meeting.owner_id)
    recipients = recipients_among(session, candidates, lambda uid: meeting_read(uid, meeting))
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
    } | {m.user_id for m in roster(session,task.task_id) if m.role=="watcher"} | {task.created_by_user_id} | set(db.get_scope_leads(task.scope_kind, task.scope_id))
    from task_queues import readers_of
    readable = readers_of(session, task, recipients)
    emit(
        session,
        [
            uid
            for uid in recipients
            if uid in readable
        ],
        "task_comment",
        dict(task_id=task.task_id, title=task.title),
        "comment:" + comment.comment_id,
        actor,
    )


def registration_submitted(session, application):
    import access

    recipients = recipients_among(session, access.holders(["registration.review"]),
                                  lambda uid: access.allowed(uid, "registration.review"))
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
