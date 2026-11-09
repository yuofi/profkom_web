"""HereBot stage 3: site notifications through the bot (backend/docs/BOT_API.md, «Уведомления
через бота»).

PUBLIC_SITE_URL; the VK row of emit and its conditions (integration, preference, link state),
email and Telegram unchanged; VK on by default at an account's first link only; GET /work
(selection, order, limit, due time, 24 hours, waiting and refused rows, the peer after a relink,
text and links of every target kind, truncation, random_id); POST /report results (sent, denied
with the link, retries and the final failure, idempotency, held rows cancelled); the hourly
expiry; the preferences' channels; retention; the additive schema on an old database; and the
statement budget (idle /work, emit, a report with 50 results).
"""
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError
from sqlalchemy import event, text

import bot_api
import notifications
from bot_models import BotLinkORM, BotStatusORM
from database import NotificationORM, UserORM, db, engine
from profile_features import PreferenceValues, collect_delivery_event
from profile_features_models import NotificationDeliveryEventORM as DeliveryORM, NotificationPreferenceORM
from settings import Settings, settings
from test_bot_api import BOT, HASH, at, body, sql
from test_bot_link import application, confirm, issue, register
from test_retention_release_criteria import archive
from test_v13_registration import filled, vk_applicant
from test_v13_tracker import work  # noqa: F401

WORK, REPORT, PREFS = "/api/bot/v1/work", "/api/bot/v1/report", "/api/profile/me/notification-preferences"
SITE = "https://profkom.example"


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    monkeypatch.setattr(settings, "PUBLIC_SITE_URL", SITE)


@pytest.fixture(autouse=True)
def held():
    bot_api.reset_deliveries()
    bot_api.reset_limits()
    yield
    bot_api.reset_deliveries()
    bot_api.reset_limits()


def linked(uid, vk, messages=True, token="ok"):
    with db._session() as s:
        bot_api.save_link(s, s.get(UserORM, uid), BotLinkORM(
            user_id=uid, vk_user_id=vk, messages_allowed=messages, messages_at=at(-10), token_status=token,
            token_at=at(-10), linked_at=at(-10), updated_at=at(-10)))
        s.commit()


def prefer(uid, **categories):
    """prefer(uid, tracker=("vk", "email")): those channels on, every other off."""
    values = PreferenceValues().model_dump()
    for category, names in categories.items():
        for name in names:
            values[category][name] = True
    with db._session() as s:
        row = s.get(NotificationPreferenceORM, uid) or NotificationPreferenceORM(user_id=uid, revision=1)
        row.preferences_json = json.dumps(values)
        s.add(row)
        s.commit()


def stored_preferences(uid):
    with db._session() as s:
        row = s.get(NotificationPreferenceORM, uid)
        return None if row is None else (json.loads(row.preferences_json), row.revision)


def emit(recipients, kind="task_status_changed", payload=None, key=None, actor=None):
    key = key or f"event-{uuid.uuid4()}"
    with db.atomic():
        with db._session() as s:
            notifications.emit(s, recipients, kind, payload or {"task_id": "task-x", "title": "Задача"}, key, actor)
    return key


def rows(**filters):
    with db._session() as s:
        return [{c.name: getattr(r, c.name) for c in DeliveryORM.__table__.columns}
                for r in s.query(DeliveryORM).filter_by(**filters).order_by(DeliveryORM.created_at, DeliveryORM.channel)]


def vk_row(delivery_id):
    return next(r for r in rows(channel="vk") if r["delivery_id"] == delivery_id)


def shift(delivery_id, **values):
    with db._session() as s:
        s.query(DeliveryORM).filter_by(delivery_id=delivery_id).update(values)
        s.commit()


def poll(client, limit=None):
    r = client.get(WORK, headers=BOT, params={"limit": limit} if limit else None)
    assert r.status_code == 200, r.text
    return r.json()["deliveries"]


def report(client, deliveries=(), **kw):
    r = client.post(REPORT, headers=BOT, json=body(hb=None, deliveries=list(deliveries), **kw))
    assert r.status_code == 200, r.text
    return r.json()


def result(delivery_id, status="sent", vk_message_id=None, error_code=None, retryable=False):
    return {"delivery_id": delivery_id, "status": status, "vk_message_id": vk_message_id,
            "error_code": error_code, "retryable": retryable}


def iso(moment):
    return moment.isoformat()


def ago(**delta):
    return datetime.now(timezone.utc) - timedelta(**delta)


def ready(make_user, vk, **categories):
    """An active account with a working link and VK on (tracker and applications by default)."""
    person = make_user()
    linked(person.user_id, vk)
    prefer(person.user_id, **(categories or {"tracker": ("vk",), "applications": ("vk",)}))
    return person


def notify(recipients):
    """A notification every recipient may read, without a target («заявки»)."""
    return emit(recipients, kind="registration_approve", payload={"registration_user_id": 1})


# ───────────────────────────── PUBLIC_SITE_URL ─────────────────────────────

@pytest.mark.parametrize("value,stored", [("", ""), ("https://profkom.example", "https://profkom.example"),
                                          (" https://profkom.example/ ", "https://profkom.example"),
                                          ("http://127.0.0.1:5173", "http://127.0.0.1:5173"),
                                          ("https://example.org/profkom/", "https://example.org/profkom")])
def test_public_site_url_has_no_trailing_slash(value, stored):
    assert Settings(PUBLIC_SITE_URL=value).PUBLIC_SITE_URL == stored


@pytest.mark.parametrize("value", ["profkom.example", "ftp://profkom.example", "https://profkom.example/?a=1",
                                   "https://", "https://pro fkom.example", "https://profkom.example/#top"])
def test_public_site_url_refuses_anything_else(value):
    with pytest.raises(ValidationError):
        Settings(PUBLIC_SITE_URL=value)


def test_public_site_url_falls_back_to_frontend_url(monkeypatch):
    monkeypatch.setenv("FRONTEND_URL", "https://front.example/")
    assert Settings().public_site_url() == "https://front.example"
    assert Settings(PUBLIC_SITE_URL="https://people.example").public_site_url() == "https://people.example"
    monkeypatch.delenv("FRONTEND_URL")
    assert Settings().public_site_url() == "http://localhost:5173"


def test_production_with_the_integration_needs_https(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("FRONTEND_URL", "http://profkom.example")
    with pytest.raises(ValidationError, match="https"):
        Settings(BOT_API_TOKEN_SHA256=HASH)
    with pytest.raises(ValidationError, match="https"):
        Settings(BOT_API_TOKEN_SHA256=HASH, PUBLIC_SITE_URL="http://people.example")
    assert Settings(BOT_API_TOKEN_SHA256=HASH, PUBLIC_SITE_URL="https://people.example").public_site_url() == "https://people.example"
    assert Settings().BOT_API_TOKEN_SHA256 == ""  # without the integration no link is sent
    monkeypatch.setenv("FRONTEND_URL", "https://profkom.example")
    assert Settings(BOT_API_TOKEN_SHA256=HASH).public_site_url() == "https://profkom.example"


# ───────────────────────────── the VK row of emit ─────────────────────────────

def test_without_the_integration_every_channel_stays_not_connected(client, make_user):
    person = make_user()
    linked(person.user_id, 100)
    prefer(person.user_id, tracker=("email", "telegram", "vk"))
    emit([person.user_id])
    assert sorted((r["channel"], r["state"]) for r in rows()) == [
        ("email", "not_connected"), ("telegram", "not_connected"), ("vk", "not_connected")]


@pytest.mark.parametrize("messages,token,queued", [(True, "ok", True), (True, "unknown", True), (True, "missing", True),
                                                   (True, "invalid", True), (False, "ok", False), (False, "missing", False)])
def test_a_vk_row_is_pending_only_while_the_vk_takes_messages(client, enabled, make_user, messages, token, queued):
    person = make_user()
    linked(person.user_id, 100, messages=messages, token=token)
    prefer(person.user_id, tracker=("email", "vk"))
    key = emit([person.user_id], payload={"task_id": "task-7", "title": "Зал"})
    vk = rows(channel="vk")
    assert [(r["state"], r["event_key"], r["source_kind"], r["source_id"], r["category"]) for r in vk] == (
        [("pending", key, "task", "task-7", "tracker")] if queued else [])
    if queued:
        assert vk[0]["attempts"] == 0 and vk[0]["next_attempt_at"] == vk[0]["created_at"] == vk[0]["updated_at"]
        assert (vk[0]["sent_at"], vk[0]["vk_message_id"], vk[0]["error_code"]) == (None, None, None)
    assert [(r["channel"], r["state"]) for r in rows(channel="email")] == [("email", "not_connected")]


def test_no_link_or_vk_off_or_another_category_queues_nothing(client, enabled, make_user):
    unlinked = make_user()
    prefer(unlinked.user_id, tracker=("vk",))
    off = make_user()
    linked(off.user_id, 101)
    prefer(off.user_id, tracker=("email",), applications=("vk",))
    other = make_user()
    linked(other.user_id, 102)
    prefer(other.user_id, tracker=("vk",))
    emit([unlinked.user_id, off.user_id])
    emit([other.user_id], kind="meeting_changed", payload={"meeting_id": "m", "title": "Созвон"})  # no category
    emit([other.user_id], kind="registration_submitted", payload={"registration_user_id": 5})  # VK off for «заявки»
    assert rows(channel="vk") == []
    assert [(r["user_id"], r["channel"]) for r in rows()] == [(off.user_id, "email")]


def test_inactive_recipients_and_the_actor_get_nothing(client, enabled, make_user):
    actor, banned, active = ready(make_user, 100), ready(make_user, 101), ready(make_user, 102)
    with db._session() as s:
        s.get(UserORM, banned.user_id).banned = True
        s.commit()
    emit([actor.user_id, banned.user_id, active.user_id], actor=actor.user_id)
    assert [r["user_id"] for r in rows(channel="vk")] == [active.user_id]


def test_direct_callers_queue_with_the_users_row_they_did_not_pass(client, enabled, make_user):
    """registration.py and membership.py call collect_delivery_event without emit."""
    person = ready(make_user, 100, applications=("vk",))
    with db.atomic():
        with db._session() as s:
            collect_delivery_event(s, person.user_id, "block_request_approved", {"request_id": "r-1"}, "block-request:r-1:1")
    assert [(r["state"], r["category"], r["source_kind"]) for r in rows(channel="vk")] == [("pending", "applications", "request")]


# ───────────────────────────── registration decisions ─────────────────────────────

@pytest.mark.parametrize("via_vk", [False, True])
def test_registration_approval_reaches_the_bot_once(client, enabled, superuser, mock_vk, via_vk):
    """Exercise the actual decision route, not a hand-built notification with an event key."""
    if via_vk:
        headers, draft = vk_applicant(client, mock_vk, vk_id="190")
        saved = client.patch("/api/registrations/me", headers=headers,
                             json={"expected_revision": draft["revision"], "fields": filled(draft, funding="budget")})
        assert saved.status_code == 200, saved.text
        applicant = SimpleNamespace(user_id=draft["user_id"], headers=headers)
    else:
        applicant = register(client, "applicant@example.com")
    assert confirm(client, issue(client, applicant)["code"], 190).status_code == 200
    before = application(client, applicant)
    route = f"/api/registrations/{applicant.user_id}/approve"
    approved = client.post(route, headers=superuser.headers, json={"expected_revision": before["revision"]})
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"

    [delivery] = poll(client)
    assert (delivery["peer_id"], delivery["text"]) == (190, f"Ваша регистрация одобрена\n{SITE}/")
    # A lost poll or report may be retried with the same VK deduplication ID.
    assert poll(client) == [delivery]
    for revision in (before["revision"], approved.json()["revision"]):
        assert client.post(route, headers=superuser.headers, json={"expected_revision": revision}).status_code == 409
    with db._session() as s:
        [notice] = s.query(NotificationORM).filter_by(user_id=applicant.user_id, kind="registration_approve").all()
        [queued] = s.query(DeliveryORM).filter_by(user_id=applicant.user_id, channel="vk").all()
        assert notice.event_key == queued.event_key == f"registration:{applicant.user_id}:decision:{approved.json()['revision']}"
    sent = result(delivery["delivery_id"], "sent", vk_message_id=19)
    report(client, [sent])
    report(client, [sent])
    assert vk_row(delivery["delivery_id"])["state"] == "sent"
    assert poll(client) == []


def test_registration_approval_respects_disabled_vk_preferences(client, enabled, superuser):
    applicant = register(client, "applicant@example.com")
    assert confirm(client, issue(client, applicant)["code"], 191).status_code == 200
    prefer(applicant.user_id, tracker=("vk",))  # Applications are off; tracker stays on.
    current = application(client, applicant)
    approved = client.post(f"/api/registrations/{applicant.user_id}/approve", headers=superuser.headers,
                           json={"expected_revision": current["revision"]})
    assert approved.status_code == 200, approved.text
    assert rows(channel="vk", user_id=applicant.user_id) == []
    assert poll(client) == []
    with db._session() as s:
        assert s.query(NotificationORM).filter_by(user_id=applicant.user_id, kind="registration_approve").count() == 1


@pytest.mark.parametrize("command,title", [
    ("reject", "Ваша регистрация отклонена"),
    ("reset-attempts", "Лимит отправок заявки на регистрацию сброшен"),
])
def test_other_registration_decisions_keep_their_bot_notice(client, enabled, superuser, command, title):
    applicant = register(client, "applicant@example.com")
    assert confirm(client, issue(client, applicant)["code"], 192).status_code == 200
    current = application(client, applicant)
    decided = client.post(f"/api/registrations/{applicant.user_id}/{command}", headers=superuser.headers,
                          json={"expected_revision": current["revision"], "reason": "Уточнить данные"})
    assert decided.status_code == 200, decided.text
    [delivery] = poll(client)
    assert (delivery["peer_id"], delivery["text"]) == (192, f"{title}\n{SITE}/")


def test_registration_approval_and_delivery_roll_back_together(client, enabled, superuser, monkeypatch):
    import profile_features

    applicant = register(client, "applicant@example.com")
    assert confirm(client, issue(client, applicant)["code"], 193).status_code == 200
    before = application(client, applicant)
    collect = profile_features.collect_delivery_event

    def fail_after_queue(*args, **kwargs):
        collect(*args, **kwargs)
        raise RuntimeError("Synthetic queue failure")

    monkeypatch.setattr(profile_features, "collect_delivery_event", fail_after_queue)
    with pytest.raises(RuntimeError, match="Synthetic queue failure"):
        client.post(f"/api/registrations/{applicant.user_id}/approve", headers=superuser.headers,
                    json={"expected_revision": before["revision"]})
    assert application(client, applicant) == before
    assert db.get_user(applicant.user_id).account_state == "pending"
    assert rows(user_id=applicant.user_id) == []
    with db._session() as s:
        assert s.query(NotificationORM).filter_by(user_id=applicant.user_id, kind="registration_approve").count() == 0


# ───────────────────────────── VK on by default ─────────────────────────────

def test_the_first_link_turns_vk_on_for_tracker_and_applications(client, enabled, make_user):
    fresh, tuned = make_user(), make_user()
    prefer(tuned.user_id, tracker=("email",), pgas=("telegram",))
    for person, vk in ((fresh, 200), (tuned, 201)):
        assert confirm(client, issue(client, person)["code"], vk).status_code == 200
    values, revision = stored_preferences(fresh.user_id)
    assert revision == 2 and values == {
        "tracker": {"email": False, "telegram": False, "vk": True},
        "applications": {"email": False, "telegram": False, "vk": True},
        "pgas": {"email": False, "telegram": False, "vk": False}}
    values, revision = stored_preferences(tuned.user_id)
    assert revision == 2 and values == {
        "tracker": {"email": True, "telegram": False, "vk": True},
        "applications": {"email": False, "telegram": False, "vk": True},
        "pgas": {"email": False, "telegram": True, "vk": False}}
    # The form the person may have open keeps its revision check.
    stale = client.put(PREFS, headers=fresh.headers, json={"expected_revision": 1, "preferences": values})
    assert stale.status_code == 409


def test_a_relink_leaves_the_preferences_as_the_person_set_them(client, enabled, make_user):
    person = make_user()
    shown = issue(client, person)["code"]
    assert confirm(client, shown, 300).status_code == 200
    data = client.get(PREFS, headers=person.headers).json()
    data["preferences"]["tracker"]["vk"] = False
    assert client.put(PREFS, headers=person.headers, json={"expected_revision": data["revision"],
                                                           "preferences": data["preferences"]}).status_code == 200
    before = stored_preferences(person.user_id)
    assert confirm(client, shown, 300).status_code == 200  # the repeat of the same code
    assert confirm(client, issue(client, person)["code"], 301).status_code == 200  # another VK
    assert confirm(client, issue(client, person)["code"], 301).status_code == 200  # the same VK again
    assert stored_preferences(person.user_id) == before


def test_vk_already_on_is_not_rewritten(client, enabled, make_user):
    person = make_user()
    prefer(person.user_id, tracker=("vk",), applications=("vk",))
    before = stored_preferences(person.user_id)
    assert confirm(client, issue(client, person)["code"], 400).status_code == 200
    assert stored_preferences(person.user_id) == before


# ───────────────────────────── GET /work ─────────────────────────────

def test_work_hands_out_the_due_rows_oldest_first_up_to_the_limit(client, enabled, work):
    member = work["member"]
    linked(member.user_id, 500)
    prefer(member.user_id, tracker=("vk",))
    task = work["task"]["task_id"]
    keys = [emit([member.user_id], payload={"task_id": task, "title": f"Работа {i}"}) for i in range(4)]
    ids = [next(r["delivery_id"] for r in rows(channel="vk") if r["event_key"] == key) for key in keys]
    # Order by created_at: the last one first, the first one second; the rest keep theirs.
    shift(ids[3], created_at=iso(ago(minutes=30)), next_attempt_at=iso(ago(minutes=30)))
    shift(ids[0], created_at=iso(ago(minutes=20)), next_attempt_at=iso(ago(minutes=20)))
    shift(ids[1], next_attempt_at=iso(ago(minutes=-5)))  # not due for five minutes
    shift(ids[2], created_at=iso(ago(hours=24, minutes=1)), next_attempt_at=iso(ago(hours=24, minutes=1)))  # too old
    handed = poll(client)
    assert [d["delivery_id"] for d in handed] == [ids[3], ids[0]]
    assert [d["delivery_id"] for d in poll(client, limit=1)] == [ids[3]]
    first = handed[0]
    assert set(first) == {"delivery_id", "peer_id", "text", "random_id", "created_at"}
    assert first["peer_id"] == 500 and re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", first["created_at"])
    assert first["text"] == f"Изменён статус задачи: Работа 3\n{SITE}/tasks/{task}"
    assert poll(client) == handed  # nothing is marked at hand-out
    assert all(r["state"] == "pending" for r in rows(channel="vk"))


def test_rows_that_cannot_be_sent_now_wait_and_go_once_fixed(client, enabled, work):
    member, task = work["member"], work["task"]["task_id"]
    linked(member.user_id, 501)
    prefer(member.user_id, tracker=("vk",))
    emit([member.user_id], payload={"task_id": task, "title": "Работа"})
    [row] = rows(channel="vk")
    before = rows()

    def handed():
        return [d["delivery_id"] for d in poll(client)]

    with db._session() as s:
        s.get(BotLinkORM, member.user_id).messages_allowed = False
        s.commit()
    assert handed() == []
    with db._session() as s:
        s.get(BotLinkORM, member.user_id).messages_allowed = True
        s.commit()
    prefer(member.user_id, tracker=("email",))
    assert handed() == []
    with db._session() as s:
        s.query(NotificationPreferenceORM).filter_by(user_id=member.user_id).update({"preferences_json": "{broken"})
        s.commit()
    assert handed() == []  # a broken preferences row reads as off, the poll still answers
    prefer(member.user_id, tracker=("vk",))
    with db._session() as s:
        bot_api.save_link(s, s.get(UserORM, member.user_id), None)
        s.commit()
    assert handed() == []
    report(client)
    assert rows() == before and bot_api.HELD.snapshot() == []  # waiting is not refusing
    linked(member.user_id, 777)
    assert handed() == [row["delivery_id"]]
    assert poll(client)[0]["peer_id"] == 777


def test_the_peer_is_the_current_vk_after_a_relink(client, enabled, work):
    member, task = work["member"], work["task"]["task_id"]
    assert confirm(client, issue(client, member)["code"], 600).status_code == 200  # VK on by default
    emit([member.user_id], payload={"task_id": task, "title": "Работа"})
    assert [d["peer_id"] for d in poll(client)] == [600]
    assert confirm(client, issue(client, member)["code"], 601).status_code == 200
    assert [d["peer_id"] for d in poll(client)] == [601]


def test_refused_rows_are_held_then_cancelled_by_the_next_report(client, enabled, work):
    member, outside, task = work["member"], work["outside"], work["task"]["task_id"]
    for label, vk in (("member", 700), ("outside", 701)):
        linked(work[label].user_id, vk)
        prefer(work[label].user_id, tracker=("vk",))
    emit([member.user_id, outside.user_id], payload={"task_id": task, "title": "Работа"})
    ids = {r["user_id"]: r["delivery_id"] for r in rows(channel="vk")}
    # The member keeps the task; the outsider never could read it (the bell: access_revoked).
    with sql() as statements:
        assert [d["delivery_id"] for d in poll(client)] == [ids[member.user_id]]
    assert not [s for s in statements if s.split()[0].upper() in ("INSERT", "UPDATE", "DELETE")]
    assert bot_api.HELD.snapshot() == [ids[outside.user_id]]
    assert [d["delivery_id"] for d in poll(client)] == [ids[member.user_id]]  # held rows are skipped in SQL
    assert vk_row(ids[outside.user_id])["state"] == "pending"
    report(client)
    assert vk_row(ids[outside.user_id])["state"] == "cancelled" and vk_row(ids[member.user_id])["state"] == "pending"
    assert vk_row(ids[outside.user_id])["updated_at"] >= iso(ago(minutes=1))
    assert bot_api.HELD.snapshot() == []


def test_an_account_that_is_gone_is_cancelled_a_pending_applicant_is_not(client, enabled, make_user, superuser):
    banned, gone, applicant = (ready(make_user, vk, applications=("vk",)) for vk in (710, 711, 712))
    for person in (banned, gone, applicant):
        key = f"registration:{person.user_id}:decision:1"
        with db.atomic():
            with db._session() as s:
                s.add(NotificationORM(notification_id=str(uuid.uuid4()), user_id=person.user_id, kind="registration_approve",
                                      payload_json="{}", event_key=key, is_read=False, created_at=iso(ago())))
                collect_delivery_event(s, person.user_id, "registration_approve", {"registration_user_id": person.user_id}, key)
    archive(client, superuser, gone)
    with db._session() as s:
        s.get(UserORM, banned.user_id).banned = True
        s.get(UserORM, applicant.user_id).account_state = "pending"
        s.commit()
    handed = poll(client)
    assert [(d["peer_id"], d["text"]) for d in handed] == [(712, f"Ваша регистрация одобрена\n{SITE}/")]  # no target: home
    report(client)
    states = {r["user_id"]: r["state"] for r in rows(channel="vk")}
    assert states == {banned.user_id: "cancelled", gone.user_id: "cancelled", applicant.user_id: "pending"}


def test_a_row_without_its_notification_is_cancelled(client, enabled, make_user):
    person = ready(make_user, 720)
    key = emit([person.user_id])
    with db._session() as s:
        s.query(NotificationORM).filter_by(event_key=key).delete()
        s.commit()
    assert poll(client) == []
    report(client)
    assert [r["state"] for r in rows(channel="vk")] == ["cancelled"]


def test_the_held_set_is_bounded():
    bot_api.HELD.add([f"d{i:05d}" for i in range(bot_api.HELD_LIMIT + 50)])
    assert len(bot_api.HELD.snapshot()) == bot_api.HELD_LIMIT
    bot_api.HELD.discard(["d00000"])
    assert len(bot_api.HELD.snapshot()) == bot_api.HELD_LIMIT - 1


def test_a_result_wins_over_holding(client, enabled, make_user):
    """A row handed out before its access ended, then held, keeps the result the bot reports."""
    person = ready(make_user, 730)
    emit([person.user_id])
    [row] = rows(channel="vk")
    bot_api.HELD.add([row["delivery_id"]])
    report(client, [result(row["delivery_id"], "sent", vk_message_id=9)])
    assert vk_row(row["delivery_id"])["state"] == "sent"


# ───────────────────────────── text, links, random_id ─────────────────────────────

ROUTES_TS = Path(__file__).resolve().parents[2] / "frontend/src/utils/routes.ts"


def test_the_route_map_mirrors_the_frontend_target_route():
    source = ROUTES_TS.read_text(encoding="utf-8")
    builders = source[source.index("const builders"):]
    builders = builders[:builders.index("};")]
    assert set(re.findall(r"^\s*(\w+):", builders, re.M)) == set(bot_api.ROUTES)


@pytest.mark.parametrize("kind,ident,path", [
    ("event", "e-1", "/events/e-1"), ("subevent", "s-1", "/subevents/s-1"), ("task", "task-1", "/tasks/task-1"),
    ("task_queue", "q-1", "/tasks/queues/q-1"), ("block", "b-1", "/blocks/b-1"), ("report", "r-1", "/reports/r-1"),
    ("material", "m-1", "/materials/m-1"), ("season", "x-1", "/seasons/x-1"), ("pgas", "12", "/pgas"),
    ("registrations", "42", "/admin/registrations"), ("block_requests", "mine", "/blocks/requests"),
    ("meeting_event", "e-1", "/meetings/event/e-1"), ("meeting_subevent", "s-1", "/meetings/subevent/s-1"),
    ("broadcast", "b-1", "/broadcasts/b-1"),
    ("task", "a b/c?d#e&é", "/tasks/a%20b%2Fc%3Fd%23e%26%C3%A9"), ("task", "x!~*'()-_.", "/tasks/x!~*'()-_."),
    ("unknown", "x", "/"), ("task", "", "/"), ("task", 7, "/"),
])
def test_target_paths(kind, ident, path):
    assert bot_api.target_path({"kind": kind, "id": ident}) == path


def test_no_target_opens_the_home_page():
    assert bot_api.target_path(None) == bot_api.target_path({}) == "/"


def test_a_long_text_is_cut_and_the_link_kept(monkeypatch):
    monkeypatch.setattr(settings, "PUBLIC_SITE_URL", SITE)
    view = {"text": "Изменён статус задачи: " + "я" * 5000, "target": {"kind": "task", "id": "task-1"}}
    message = bot_api.delivery_text(view)
    body_, link = message.rsplit("\n", 1)
    assert len(message) == 4000 and link == f"{SITE}/tasks/task-1" and body_.endswith("…")
    assert body_.startswith("Изменён статус задачи: яяя")
    short = {"text": "Ровно", "target": None}
    assert bot_api.delivery_text(short) == f"Ровно\n{SITE}/"
    exact = {"text": "т" * (4000 - len(SITE) - 2), "target": None}
    assert bot_api.delivery_text(exact) == exact["text"] + f"\n{SITE}/"


def test_random_id_is_the_first_31_bits_of_sha256_and_never_0(monkeypatch):
    for delivery_id in ("a", str(uuid.uuid4()), "d" * 36):
        expected = int.from_bytes(hashlib.sha256(delivery_id.encode()).digest()[:4], "big") >> 1
        assert bot_api.random_id(delivery_id) == expected and 1 <= expected <= 2**31 - 1

    class Zero:
        def __init__(self, _data):
            pass

        def digest(self):
            return bytes(32)
    monkeypatch.setattr(bot_api.hashlib, "sha256", Zero)
    assert bot_api.random_id("anything") == 1


def test_texts_and_links_through_work(client, enabled, work, superuser, make_user):
    member, task = work["member"], work["task"]["task_id"]
    linked(member.user_id, 800)
    prefer(member.user_id, tracker=("vk",))
    linked(superuser.user_id, 801)
    prefer(superuser.user_id, applications=("vk",))
    applicant = make_user(name="Иван", surname="Заявкин")
    emit([member.user_id], kind="task_assignment", payload={"task_id": task, "title": "Работа"})
    emit([superuser.user_id], kind="registration_submitted", payload={"registration_user_id": applicant.user_id})
    handed = {d["peer_id"]: d for d in poll(client)}
    assert handed[800]["text"] == f"Вам назначена задача: Работа\n{SITE}/tasks/{task}"
    assert handed[801]["text"] == f"Новая заявка на регистрацию: Заявкин Иван\n{SITE}/admin/registrations"
    for d in handed.values():
        assert d["random_id"] == bot_api.random_id(d["delivery_id"])
    assert [d["random_id"] for d in poll(client)] == [d["random_id"] for d in handed.values()]


# ───────────────────────────── POST /report ─────────────────────────────

def test_sent_stores_the_message_and_the_time(client, enabled, make_user):
    person = ready(make_user, 900)
    notify([person.user_id])
    [d] = poll(client)
    answer = report(client, [result(d["delivery_id"], "sent", vk_message_id=12345)])
    row = vk_row(d["delivery_id"])
    assert (row["state"], row["vk_message_id"], row["attempts"], row["error_code"]) == ("sent", 12345, 1, None)
    assert row["sent_at"] == row["updated_at"] and row["sent_at"][:19] == answer["server_time"][:19]
    assert poll(client) == []


def test_denied_turns_the_links_messages_off(client, enabled, make_user, superuser):
    person, other = ready(make_user, 910), ready(make_user, 911)
    notify([person.user_id, other.user_id])
    ids = {r["user_id"]: r["delivery_id"] for r in rows(channel="vk")}
    answer = report(client, [result(ids[person.user_id], "denied", error_code=901)])
    row = vk_row(ids[person.user_id])
    assert (row["state"], row["error_code"], row["attempts"]) == ("denied", "901", 1)
    with db._session() as s:
        link = s.get(BotLinkORM, person.user_id)
        assert (link.messages_allowed, link.messages_at, link.updated_at) == (False, answer["server_time"], answer["server_time"])
        assert s.get(UserORM, person.user_id).bot_link_state == "messages_denied"
        assert s.get(UserORM, other.user_id).bot_link_state == "ok"
    assert [d["delivery_id"] for d in poll(client)] == [ids[other.user_id]]
    notify([person.user_id])  # no new VK row while messages are denied
    assert [r["user_id"] for r in rows(channel="vk", state="pending")] == [other.user_id]
    # A later allow from Long Poll restores the link.
    report(client, vk_events=[{"vk_user_id": 910, "event": "message_allow", "at": at(1)}])
    with db._session() as s:
        assert s.get(UserORM, person.user_id).bot_link_state == "ok"


def test_denied_does_not_override_a_later_stored_time(client, enabled, make_user):
    person = ready(make_user, 920)
    with db._session() as s:
        s.get(BotLinkORM, person.user_id).messages_at = at(10)  # the bot's clock ahead
        s.commit()
    emit([person.user_id])
    [row] = rows(channel="vk")
    report(client, [result(row["delivery_id"], "denied", error_code=901)])
    assert vk_row(row["delivery_id"])["state"] == "denied"
    with db._session() as s:
        assert s.get(BotLinkORM, person.user_id).messages_allowed is True


def test_retryable_failures_wait_1_5_30_120_minutes_then_fail(client, enabled, make_user):
    person = ready(make_user, 930)
    emit([person.user_id])
    [row] = rows(channel="vk")
    waits = []
    for attempt in range(1, 6):
        before = datetime.now(timezone.utc)
        report(client, [result(row["delivery_id"], "failed", error_code=10, retryable=True)])
        stored = vk_row(row["delivery_id"])
        assert stored["attempts"] == attempt and stored["error_code"] == "10"
        if attempt < 5:
            assert stored["state"] == "pending"
            waits.append(round((datetime.fromisoformat(stored["next_attempt_at"]) - before).total_seconds() / 60))
            assert poll(client) == []  # not due yet
    assert waits == [1, 5, 30, 120]
    assert vk_row(row["delivery_id"])["state"] == "failed"
    shift(row["delivery_id"], next_attempt_at=iso(ago(minutes=1)))
    assert poll(client) == []


def test_a_due_retry_is_handed_out_again(client, enabled, make_user):
    person = ready(make_user, 935)
    notify([person.user_id])
    [d] = poll(client)
    report(client, [result(d["delivery_id"], "failed", error_code="network", retryable=True)])
    assert poll(client) == [] and vk_row(d["delivery_id"])["error_code"] == "network"
    shift(d["delivery_id"], next_attempt_at=iso(ago(seconds=1)))
    assert poll(client) == [d]  # the same random_id: VK drops a copy it already has


def test_a_final_failure_is_failed_at_once(client, enabled, make_user):
    person = ready(make_user, 940)
    emit([person.user_id])
    [row] = rows(channel="vk")
    report(client, [result(row["delivery_id"], "failed", error_code=902, retryable=False)])
    stored = vk_row(row["delivery_id"])
    assert (stored["state"], stored["attempts"], stored["error_code"]) == ("failed", 1, "902")
    with db._session() as s:
        assert s.get(UserORM, person.user_id).bot_link_state == "ok"  # only 901 touches the link


@pytest.mark.parametrize("status,error_code,retryable,state,stored", [
    ("failed", 902, False, "failed", "902"), ("failed", 10, True, "pending", "10"),
    ("failed", "network", True, "pending", "network"), ("failed", "http_502", True, "pending", "http_502"),
    ("failed", "invalid", False, "failed", "invalid"), ("failed", "unexpected", False, "failed", "unexpected"),
    ("failed", "x" * 80, False, "failed", "x" * 64), ("denied", 901, False, "denied", "901"),
    ("sent", None, False, "sent", None),
])
def test_what_the_bot_sends_as_error_code_is_kept_as_text(client, enabled, make_user, status, error_code, retryable, state, stored):
    """The bot's words (decision of 2026-11-04, stage 3): a VK code as an integer, `network`,
    `http_<status>`, `invalid` or `unexpected` without one, null with `sent`."""
    person = ready(make_user, 965)
    emit([person.user_id])
    [row] = rows(channel="vk")
    report(client, [result(row["delivery_id"], status, error_code=error_code, retryable=retryable)])
    after = vk_row(row["delivery_id"])
    assert (after["state"], after["error_code"], after["attempts"]) == (state, stored, 1)


def test_sent_without_a_message_id_is_still_sent(client, enabled, make_user):
    person = ready(make_user, 966)
    emit([person.user_id])
    [row] = rows(channel="vk")
    report(client, [result(row["delivery_id"], "sent", vk_message_id=None)])
    after = vk_row(row["delivery_id"])
    assert (after["state"], after["vk_message_id"], after["sent_at"] is not None) == ("sent", None, True)


def test_deliveries_the_bot_did_not_try_stay_pending_and_come_back(client, enabled, make_user):
    people = [ready(make_user, 970 + i) for i in range(3)]
    notify([p.user_id for p in people])
    handed = poll(client)
    assert len(handed) == 3
    report(client, [result(handed[0]["delivery_id"], "sent", vk_message_id=1)])
    assert [(vk_row(d["delivery_id"])["state"], vk_row(d["delivery_id"])["attempts"]) for d in handed[1:]] == [("pending", 0)] * 2
    assert poll(client) == handed[1:]


def test_work_without_a_limit_hands_out_50(client, enabled, make_user):
    people = [ready(make_user, 980 + i) for i in range(55)]
    notify([p.user_id for p in people])
    assert len(poll(client)) == 50 and len(poll(client, limit=100)) == 55


def test_the_bots_delivery_counters_are_kept_with_the_heartbeat(client, enabled):
    beat = {"version": "2.4.0", "commit": "", "started_at": at(-1), "interval_s": 60,
            "counters": {"chats": 3, "deliveries_sent": 40, "deliveries_denied": 2, "deliveries_failed": 3}}
    r = client.post(REPORT, headers=BOT, json=body(hb=beat))
    assert r.status_code == 200, r.text
    with db._session() as s:
        stored = json.loads(s.get(BotStatusORM, 1).heartbeat_json)["counters"]
    assert stored == {"chats": 3, "deliveries_sent": 40, "deliveries_denied": 2, "deliveries_failed": 3}


def test_results_are_idempotent_and_unknown_ones_skipped(client, enabled, make_user):
    person = ready(make_user, 950)
    emit([person.user_id])
    emit([person.user_id])
    first, second = (r["delivery_id"] for r in rows(channel="vk"))
    report(client, [result(first, "sent", vk_message_id=1), result(first, "failed", retryable=True),
                    result("no-such-delivery", "sent", vk_message_id=2), result(second, "queued"),
                    {**result(second, "teleported"), "extra": True}])
    assert (vk_row(first)["state"], vk_row(first)["attempts"]) == ("sent", 1)  # the first result of a row counts
    assert (vk_row(second)["state"], vk_row(second)["attempts"]) == ("pending", 0)
    before = rows()
    with sql() as statements:
        report(client, [result(first, "failed", error_code=902), result(first, "sent", vk_message_id=3)])
    assert rows() == before
    words = [s.split()[0].upper() for s in statements]
    assert words.count("UPDATE") == 1 and "INSERT" not in words  # bot_status only
    # A repeat of the same report (its report_id) changes nothing either.
    payload = body(hb=None, deliveries=[result(second, "sent", vk_message_id=4)])
    assert client.post(REPORT, headers=BOT, json=payload).json()["duplicate"] is False
    assert client.post(REPORT, headers=BOT, json={**payload, "deliveries": [result(second, "denied")]}).json()["duplicate"] is True
    assert vk_row(second)["state"] == "sent"


def test_at_most_100_results(client, enabled):
    many = [result(f"d-{i}") for i in range(101)]
    r = client.post(REPORT, headers=BOT, json=body(deliveries=many))
    assert (r.status_code, r.json()["detail"]["code"]) == (422, "validation_error")
    assert client.post(REPORT, headers=BOT, json=body(deliveries=many[:100])).status_code == 200
    for bad in ({"status": "sent"}, {"delivery_id": "", "status": "sent"}, {"delivery_id": "x", "status": "sent", "vk_message_id": -1}):
        assert client.post(REPORT, headers=BOT, json=body(deliveries=[bad])).status_code == 422


def test_the_hourly_cleanup_expires_rows_pending_for_24_hours(client, enabled, make_user):
    person = ready(make_user, 960, tracker=("vk", "email"))
    old, young = emit([person.user_id]), emit([person.user_id])
    by_key = {r["event_key"]: r["delivery_id"] for r in rows(channel="vk")}
    for key in (old,):
        shift(by_key[key], created_at=iso(ago(hours=25)), next_attempt_at=iso(ago(hours=25)))
    with db._session() as s:
        s.query(DeliveryORM).filter_by(channel="email").update({"created_at": iso(ago(hours=25))})
        s.commit()
    report(client)  # the first report runs the hourly pass
    assert vk_row(by_key[old])["state"] == "expired" and vk_row(by_key[young])["state"] == "pending"
    assert {r["state"] for r in rows(channel="email")} == {"not_connected"}
    shift(by_key[young], created_at=iso(ago(hours=25)))
    report(client)  # within the hour: no pass
    assert vk_row(by_key[young])["state"] == "pending"
    with db._session() as s:
        s.get(BotStatusORM, 1).cleaned_at = at(-61)
        s.commit()
    with sql() as statements:
        report(client)
    assert vk_row(by_key[young])["state"] == "expired"
    assert len([s for s in statements if s.startswith("UPDATE notification_delivery_events")]) == 1


# ───────────────────────────── preferences ─────────────────────────────

def test_preferences_name_each_channels_state(client, make_user, monkeypatch):
    person = make_user()

    def channels():
        data = client.get(PREFS, headers=person.headers).json()
        assert data["delivery_status"] == "not_connected"
        return data["channels"]
    off = {"email": "not_connected", "telegram": "not_connected", "vk": "not_connected"}
    assert channels() == off
    linked(person.user_id, 1000)
    assert channels() == off  # the integration is off
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    for messages, token, state in ((True, "ok", "ready"), (True, "missing", "ready"), (True, "invalid", "ready"),
                                   (False, "ok", "link_required")):
        with db._session() as s:
            link = s.get(BotLinkORM, person.user_id)
            link.messages_allowed, link.token_status = messages, token
            bot_api.save_link(s, s.get(UserORM, person.user_id), link)
            s.commit()
        assert channels() == {**off, "vk": state}
    with db._session() as s:
        bot_api.save_link(s, s.get(UserORM, person.user_id), None)
        s.commit()
    assert channels() == {**off, "vk": "link_required"}
    saved = client.put(PREFS, headers=person.headers, json={"expected_revision": 1, "preferences": PreferenceValues().model_dump()})
    assert saved.status_code == 200 and saved.json()["channels"] == {**off, "vk": "link_required"}


def test_preferences_read_no_more_sql_with_the_integration(client, make_user, monkeypatch):
    person = make_user()
    linked(person.user_id, 1001)

    def count():
        with sql() as statements:
            assert client.get(PREFS, headers=person.headers).status_code == 200
        return len(statements)
    off = count()
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    assert count() == off


# ───────────────────────────── retention ─────────────────────────────

def test_retention_removes_the_accounts_deliveries(client, enabled, make_user, superuser):
    from account_cleanup import purge

    person, other = ready(make_user, 1100), ready(make_user, 1101)
    emit([person.user_id, other.user_id])
    archive(client, superuser, person)
    assert {r["user_id"] for r in rows(channel="vk")} == {person.user_id, other.user_id}  # the archive keeps them
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 1
    assert [r["user_id"] for r in rows()] == [other.user_id]


# ───────────────────────────── the old schema ─────────────────────────────

def test_an_old_delivery_table_gains_the_queue_twice(tmp_path):
    path = tmp_path / "old-deliveries.db"
    root = Path(__file__).resolve().parents[1]
    env = {**__import__("os").environ, "DATABASE_PATH": str(path)}
    subprocess.run([sys.executable, "-c", "import database"], cwd=root, env=env, check=True, capture_output=True)
    added = ("attempts", "next_attempt_at", "sent_at", "vk_message_id", "error_code", "updated_at")
    with sqlite3.connect(path) as c:
        c.execute("DROP INDEX ix_delivery_vk_pending")
        for column in added:
            c.execute(f"ALTER TABLE notification_delivery_events DROP COLUMN {column}")
        c.execute("INSERT INTO notification_delivery_events (delivery_id, user_id, event_key, category, source_kind, "
                  "source_id, channel, state, created_at) VALUES ('d-1', 7, 'k', 'tracker', 'task', 't', 'vk', "
                  "'not_connected', '2026-11-01T00:00:00+00:00')")
    script = ("import json, database; from sqlalchemy import text; c = database.engine.connect(); "
              "cols = [r[1] for r in c.execute(text('PRAGMA table_info(notification_delivery_events)'))]; "
              "index = c.execute(text(\"SELECT sql FROM sqlite_master WHERE name = 'ix_delivery_vk_pending'\")).scalar(); "
              "row = list(c.execute(text(\"SELECT state, attempts, next_attempt_at FROM notification_delivery_events\")).one()); "
              "unique = c.execute(text(\"SELECT count(*) FROM sqlite_master WHERE name = 'unique_profile_delivery'\")).scalar(); "
              f"c.close(); print(json.dumps([[cols.count(n) for n in {list(added)!r}], index, row, unique]))")
    for _ in range(2):
        out = subprocess.run([sys.executable, "-c", script], cwd=root, env=env, check=True, capture_output=True, text=True)
        counts, index, row, unique = json.loads(out.stdout.strip().splitlines()[-1])
        assert counts == [1] * len(added) and unique == 1
        assert "WHERE channel = 'vk' AND state = 'pending'" in index and "(next_attempt_at, created_at)" in index
        assert row == ["not_connected", 0, None]
    with sqlite3.connect(path) as c:
        assert c.execute("PRAGMA quick_check").fetchone()[0] == "ok"


def test_a_new_database_has_the_same_index():
    with engine.connect() as c:
        index = c.execute(text("SELECT sql FROM sqlite_master WHERE name = 'ix_delivery_vk_pending'")).scalar()
    assert "next_attempt_at, created_at" in index and "channel = 'vk' AND state = 'pending'" in index


# ───────────────────────────── the statement budget ─────────────────────────────

def test_an_idle_poll_is_one_select_over_the_partial_index(client, enabled, make_user):
    """Of the deliveries: the first SELECT of an idle poll is the pause and the open commands'
    (test_bot_console), the third the batches' (test_bot_broadcasts)."""
    person = ready(make_user, 1200)
    notify([person.user_id])
    [d] = poll(client)
    report(client, [result(d["delivery_id"], "sent", vk_message_id=1)])
    for _ in range(2):
        with sql() as statements:
            assert poll(client) == []
        assert [s for s in statements if "notification_delivery_events" in s] == statements[1:2], statements
        assert len(statements) == 3, statements
    bot_api.HELD.add(["held-1"])  # held ids are part of the same statement
    seen = []

    def keep(_conn, _cursor, statement, parameters, *_):
        seen.append((statement, parameters))
    event.listen(engine, "before_cursor_execute", keep)
    try:
        assert poll(client) == []
    finally:
        event.remove(engine, "before_cursor_execute", keep)
    [_console, (statement, parameters), _batches] = seen
    with engine.connect() as c:
        plan = [str(row[-1]) for row in c.exec_driver_sql("EXPLAIN QUERY PLAN " + statement, parameters)]
    assert any("ix_delivery_vk_pending" in step for step in plan), plan


def test_emit_costs_the_same_statements_with_the_integration(client, make_user, monkeypatch):
    people = [make_user() for _ in range(6)]
    for i, person in enumerate(people):
        linked(person.user_id, 1300 + i)
        prefer(person.user_id, tracker=("email", "vk"))

    def count():
        with sql() as statements:
            emit([p.user_id for p in people], payload={"task_id": "task-z", "title": "Задача"})
        return [s.split()[0].upper() for s in statements]
    off = count()
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    on = count()
    assert on == off, (off, on)
    assert {(r["channel"], r["state"]) for r in rows()} == {("email", "not_connected"), ("vk", "not_connected"), ("vk", "pending")}
    assert off.count("INSERT") == 2  # the notifications and the delivery rows, one statement each


def test_a_task_status_change_costs_the_same_statements_with_the_integration(client, work, make_user, monkeypatch):
    member, master, task = work["member"], work["master"], work["task"]
    linked(member.user_id, 1400)
    prefer(member.user_id, tracker=("email", "vk"))

    def change(status):
        revision = client.get(f"/api/tasks/{task['task_id']}", headers=master.headers).json()["revision"]
        with sql() as statements:
            r = client.post(f"/api/tasks/{task['task_id']}/status", headers=master.headers,
                            json={"expected_revision": revision, "status": status})
        assert r.status_code == 200, r.text
        return len(statements)
    off = [change("in_progress"), change("open")]
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    on = [change("in_progress"), change("open")]
    assert on == off
    assert [r["state"] for r in rows(channel="vk")] == ["not_connected", "not_connected", "pending", "pending"]


def test_a_report_with_50_results_reads_the_rows_once(client, enabled, make_user):
    people = [ready(make_user, 1500 + i) for i in range(50)]
    notify([p.user_id for p in people])
    handed = poll(client)
    assert len(handed) == 50
    statuses = ["sent"] * 40 + ["failed-retry"] * 5 + ["failed"] * 3 + ["denied"] * 2
    results = []
    for d, status in zip(handed, statuses):
        if status == "failed-retry":
            results.append(result(d["delivery_id"], "failed", error_code=10, retryable=True))
        elif status == "failed":
            results.append(result(d["delivery_id"], "failed", error_code=902))
        elif status == "denied":
            results.append(result(d["delivery_id"], "denied", error_code=901))
        else:
            results.append(result(d["delivery_id"], "sent", vk_message_id=1))
    report(client)  # the first report's hourly pass, out of the count
    with sql() as statements:
        report(client, results)
    reads = [s for s in statements if s.lstrip().upper().startswith("SELECT") and "FROM notification_delivery_events" in s]
    assert len(reads) == 1 and " IN " in reads[0]
    # BEGIN, bot_status, the rows, their one UPDATE (executemany), the denied links with their
    # accounts, then the flush: bot_links, bot_status, users.bot_link_state.
    assert len(statements) == 8, statements
    assert len([s for s in statements if s.startswith("UPDATE notification_delivery_events")]) == 1
    states = [vk_row(d["delivery_id"])["state"] for d in handed]
    assert states == ["sent"] * 40 + ["pending"] * 5 + ["failed"] * 3 + ["denied"] * 2
