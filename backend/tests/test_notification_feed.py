"""Notifications: a keyset page, the bell's count, and what each one says and opens
(GL-08, GL-16)."""
import json
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import event

from database import db, engine, MeetingORM, NotificationORM
from domain_models import BlockApplicationORM
from models import Block
from test_workspace_read_batches import notices


def test_notification_pages_are_a_keyset_with_an_unread_filter_and_an_exact_count(client, make_user):
    user = make_user()
    notices(user.user_id, [("leadership_changed", {}, index % 3 == 0) for index in range(45)])
    seen, cursor, statements = [], None, []

    def record(_c, _cursor, statement, *_rest):
        if "FROM notifications" in statement:
            statements.append(statement)
    event.listen(engine, "before_cursor_execute", record)
    try:
        while True:
            page = client.get("/api/notifications", headers=user.headers,
                              params={"limit": 20, **({"cursor": cursor} if cursor else {})}).json()
            seen += [item["id"] for item in page["items"]]
            cursor = page["next_cursor"]
            if not cursor:
                break
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert seen == [f"notice-{user.user_id}-{n}" for n in reversed(range(45))]
    assert all("LIMIT" in statement for statement in statements) and len(statements) == 3
    unread = client.get("/api/notifications", headers=user.headers, params={"unread": True, "limit": 100}).json()
    assert len(unread["items"]) == 30 and all(item["read_at"] is None for item in unread["items"])
    assert client.get("/api/notifications/unread-count", headers=user.headers).json() == {"count": 30}
    assert client.get("/api/workspace/home", headers=user.headers).status_code == 200
    broken = client.get("/api/notifications", headers=user.headers, params={"cursor": "broken"})
    assert broken.status_code == 422 and broken.json()["detail"]["code"] == "invalid_input"
    assert client.get("/api/notifications", headers=user.headers, params={"limit": 101}).status_code == 422


def test_each_notification_says_what_happened_and_opens_its_object(client, superuser, make_user):
    applicant = make_user(name="Иван", surname="Заявкин")
    outsider = make_user()
    db.create_block(Block(name="Notice block", master=""))
    from membership import block_id_for
    bid = block_id_for("Notice block")
    now = datetime.now(timezone.utc).isoformat()
    with db.atomic():
        with db._session() as s:
            s.add(BlockApplicationORM(request_id="request-notice", user_id=applicant.user_id, block_id=bid,
                                      state="pending_hr", created_at=now, stage_entered_at=now))
            s.add(MeetingORM(meeting_id="meeting-notice", owner_kind="event", owner_id="event-notice",
                             title="Планёрка", starts_at=now, join_url="https://example.invalid/meet"))
            s.commit()
    review = ("block_request_pending_hr", {"request_id": "request-notice", "scope_kind": "block", "scope_id": "Notice block"}, False)
    notices(superuser.user_id, [
        ("registration_submitted", {"registration_user_id": applicant.user_id}, False),
        review,
        ("meeting_changed", {"meeting_id": "meeting-notice", "owner_kind": "event", "owner_id": "event-notice", "title": "Планёрка"}, False),
        ("deputy_event_leader_assignment", {"scope_kind": "event", "scope_id": "event-notice"}, False),
        ("leadership_changed", {}, False),
        ("task_assignment", {"task_id": "missing", "title": "Скрытая"}, False),
    ])
    notices(applicant.user_id, [
        ("block_request_approved", {"request_id": "request-notice"}, False),
        ("block_request_rejected", {}, False),
        ("registration_approve", {}, False),
    ])
    notices(outsider.user_id, [review, ("registration_submitted", {"registration_user_id": applicant.user_id}, False)])

    def inbox(actor):
        return [(item["kind"], item["text"], item["target"]) for item in reversed(
            client.get("/api/notifications", headers=actor.headers).json()["items"])]

    assert inbox(superuser) == [
        ("registration_submitted", "Новая заявка на регистрацию: Заявкин Иван", {"kind": "registrations", "id": str(applicant.user_id)}),
        ("block_request_pending_hr", "Новая заявка в блок «Notice block»", {"kind": "block_requests", "id": "request-notice"}),
        ("meeting_changed", "Созвон изменён: Планёрка", {"kind": "meeting_event", "id": "event-notice"}),
        ("deputy_event_leader_assignment", "Вы назначены заместителем руководителя мероприятия", {"kind": "event", "id": "event-notice"}),
        ("leadership_changed", "Изменился состав руководства", None),
        ("access_revoked", "Доступ к объекту завершён", None),
    ]
    assert inbox(applicant) == [
        ("block_request_approved", "Заявка в блок «Notice block» одобрена", {"kind": "block_requests", "id": "request-notice"}),
        ("block_request_rejected", "Заявка в блок отклонена", {"kind": "block_requests", "id": "mine"}),
        ("registration_approve", "Ваша регистрация одобрена", None),
    ]
    # Neither the request nor the applicant's name reaches someone who cannot review them.
    assert inbox(outsider) == [("access_revoked", "Доступ к объекту завершён", None)] * 2
    # Only a service-account sign-in notice carries details (owner 2026-11-08, item 25).
    for actor in (superuser, applicant, outsider):
        assert {item["details"] for item in client.get("/api/notifications", headers=actor.headers).json()["items"]} == {None}


def test_a_decided_block_request_notifies_the_applicant_with_its_id(client, make_user):
    applicant = make_user(in_profcom=True)
    db.create_block(Block(name="Notice decision", master="", is_hr=True))
    from membership import block_id_for
    bid = block_id_for("Notice decision")
    made = client.post("/api/block-requests", headers=applicant.headers, json={"block_id": bid})
    assert made.status_code == 200, made.text
    request = made.json()
    decided = client.post(f"/api/block-requests/{request['request_id']}/withdraw", headers=applicant.headers,
                          json={"expected_revision": request["revision"]})
    assert decided.status_code == 200, decided.text
    with db._session() as s:
        row = s.query(NotificationORM).filter_by(user_id=applicant.user_id, kind="block_request_withdrawn").one()
        assert json.loads(row.payload_json) == {"request_id": request["request_id"]}
