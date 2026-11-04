"""HereBot stage 4: broadcasts through the bot (backend/docs/BOT_API.md, «Рассылки»).

Who sends, reads and cancels; the integration off; the text and its idempotency key; nobody to
reach; the recipient list fixed at send (who is in it, later links, relinks); batches of 100
in user_id order; the bell notification to every active account but the author; GET /work
(the cap of 5, due time, 24 hours, peer_ids, random_id); POST /report (each result, a sent
message after a cancellation, denied with the link, retries and the fifth attempt, empty
batches); the hourly expiry; cancel; the list and its counts; retention; the tables on an old
database; and the statement budget (idle /work, /work with batches, a report with 5 × 100
results, a send, a list page, /api/session).
"""
import hashlib
import json
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import event

import bot_api
import broadcasts
from bot_link import iso, state_of
from bot_models import BotLinkORM, BroadcastBatchORM, BroadcastORM, BroadcastRecipientORM
from database import AuditLogORM, NotificationORM, UserORM, db, engine
from profile_features import delivery_category
from profile_features_models import NotificationDeliveryEventORM as DeliveryORM
from settings import settings
from test_bot_api import BOT, HASH, at, body, code, sql, team  # noqa: F401
from test_bot_notify import linked
from test_retention_release_criteria import archive

URL, WORK, REPORT = "/api/broadcasts", "/api/bot/v1/work", "/api/bot/v1/report"
COUNTS = ("total", "pending", "sent", "denied", "failed", "cancelled", "expired")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    monkeypatch.setattr(settings, "PUBLIC_SITE_URL", "https://profkom.example")


@pytest.fixture(autouse=True)
def held():
    bot_api.reset_deliveries()
    yield
    bot_api.reset_deliveries()


@pytest.fixture
def chair(superuser):
    """The chair alone, for the tests that need nobody else from `team`."""
    return superuser


@pytest.fixture
def sender(client, team):
    """The outsider of `team`, made a broadcast sender by the chair."""
    client.put(f"{URL}/senders/{team['outsider'].user_id}", json={"sender": True},
               headers=team["chair"].headers).raise_for_status()
    return team["outsider"]


# ───────────────────────────── helpers ─────────────────────────────

def crowd(n, vk, state="ok"):
    """n active accounts linked to VKs vk, vk + 1, …, written directly: [(user_id, vk)]."""
    tokens = {"ok": "ok", "token_missing": "missing", "token_invalid": "invalid", "messages_denied": "ok"}
    with db._session() as s:
        users = [UserORM(kkr_score=0, group_number="101", blocks="") for _ in range(n)]
        s.add_all(users)
        s.flush()
        for i, u in enumerate(users):
            link = BotLinkORM(user_id=u.user_id, vk_user_id=vk + i, messages_allowed=state != "messages_denied",
                              messages_at=at(-10), token_status=tokens[state], token_at=at(-10), linked_at=at(-10),
                              updated_at=at(-10))
            s.add(link)
            u.bot_link_state = state_of(link)
        s.commit()
        return [(u.user_id, vk + i) for i, u in enumerate(users)]


def post(client, actor, text="Собрание в пятницу в 18:00", key=None):
    return client.post(URL, headers=actor.headers, json={"text": text, **({"idempotency_key": key} if key else {})})


def send(client, actor, text="Собрание в пятницу в 18:00", key=None):
    r = post(client, actor, text, key)
    assert r.status_code == 200, r.text
    return r.json()


def poll(client, **params):
    r = client.get(WORK, headers=BOT, params=params or None)
    assert r.status_code == 200, r.text
    return r.json()["broadcasts"]


def report(client, *entries, **kw):
    r = client.post(REPORT, headers=BOT, json=body(hb=None, broadcasts=list(entries), **kw))
    assert r.status_code == 200, r.text
    return r.json()


def outcome(peer, status="sent", vk_message_id=None, error_code=None, retryable=False):
    return {"peer_id": peer, "status": status, "vk_message_id": vk_message_id, "error_code": error_code,
            "retryable": retryable}


def entry(batch, *results, status="sent", **kw):
    """The batch's results: those given, else `status` for every peer."""
    return {"batch_id": batch["batch_id"], "results": list(results) or [outcome(p, status, **kw) for p in batch["peer_ids"]]}


def recipients(bid):
    with db._session() as s:
        return {r.user_id: dict(vk=r.vk_user_id, batch=r.batch_id, state=r.state, message=r.vk_message_id, error=r.error_code)
                for r in s.query(BroadcastRecipientORM).filter_by(broadcast_id=bid)}


def batches(bid):
    with db._session() as s:
        return [{c.name: getattr(b, c.name) for c in BroadcastBatchORM.__table__.columns}
                for b in s.query(BroadcastBatchORM).filter_by(broadcast_id=bid).order_by(BroadcastBatchORM.batch_id)]


def row(bid):
    with db._session() as s:
        b = s.get(BroadcastORM, bid)
        return None if b is None else {c.name: getattr(b, c.name) for c in BroadcastORM.__table__.columns}


def shift_batches(bid, **values):
    with db._session() as s:
        s.query(BroadcastBatchORM).filter_by(broadcast_id=bid).update(values)
        s.commit()


def due(bid):
    shift_batches(bid, next_attempt_at=iso(datetime.now(timezone.utc) - timedelta(seconds=1)))


def counts(client, actor, bid):
    r = client.get(f"{URL}/{bid}", headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()["counts"]


def tally(**values):
    return {name: values.get(name, 0) for name in COUNTS}


def bell(client, actor):
    r = client.get("/api/notifications", headers=actor.headers)
    assert r.status_code == 200, r.text
    return [n for n in r.json()["items"] if n["kind"] == "broadcast"]


def audits(reason):
    with db._session() as s:
        return [(a.target_kind, a.target_id, a.changed_by_user_id, json.loads(a.old_values_json), json.loads(a.new_values_json))
                for a in s.query(AuditLogORM).filter_by(reason=reason).order_by(AuditLogORM.id)]


def stored():
    with db._session() as s:
        return [s.query(m).count() for m in (BroadcastORM, BroadcastBatchORM, BroadcastRecipientORM)] + [
            s.query(NotificationORM).filter_by(kind="broadcast").count(), s.query(AuditLogORM).filter_by(target_kind="broadcast").count()]


def random_id(batch_id):
    return int.from_bytes(hashlib.sha256(batch_id.encode()).digest()[:4], "big") >> 1 or 1


# ───────────────────────────── who ─────────────────────────────

def test_the_chair_deputies_and_senders_send_others_only_read(client, enabled, team, sender, make_user):
    linked(team["member"].user_id, 2001)
    gone = make_user(name="gone", surname="Архивный")
    client.put(f"{URL}/senders/{gone.user_id}", json={"sender": True}, headers=team["chair"].headers).raise_for_status()
    archive(client, team["chair"], gone)
    made = []
    for who in ("chair", "deputy", "outsider"):
        actor = team[who]
        assert client.get(f"{URL}/audience", headers=actor.headers).status_code == 200, who
        made.append(send(client, actor, f"Текст {who}")["broadcast_id"])
        assert client.get(URL, headers=actor.headers).status_code == 200, who
        assert counts(client, actor, made[-1]) == tally(total=1, pending=1), who
    # The IT master and the other block master hold no sender role; a member none at all.
    for who in ("it", "other", "member"):
        actor = team[who]
        for method, path in (("GET", f"{URL}/audience"), ("POST", URL), ("GET", URL), ("POST", f"{URL}/{made[0]}/cancel")):
            r = client.request(method, path, headers=actor.headers, json={"text": "x"} if path == URL and method == "POST" else None)
            assert (r.status_code, code(r)) == (403, "forbidden"), (who, method, path, r.text)
        page = client.get(f"{URL}/{made[0]}", headers=actor.headers)
        assert page.status_code == 200 and page.json()["counts"] is None, who
    assert client.get(f"{URL}/{made[0]}", headers=gone.headers).status_code in (401, 403)
    assert client.post(URL, headers=gone.headers, json={"text": "x"}).status_code in (401, 403)
    assert stored()[0] == 3
    # The capability is the server's rule.
    for who, can in (("chair", True), ("deputy", True), ("outsider", True), ("it", False), ("member", False)):
        caps = client.get("/api/session", headers=team[who].headers).json()["capabilities"]
        assert ("send_broadcast" in caps) == can, who


def test_with_the_integration_off_audience_and_send_are_404_the_rest_works(client, team, monkeypatch):
    chair, member = team["chair"], team["member"]
    linked(member.user_id, 2101)
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    made = send(client, chair)["broadcast_id"]
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", "")
    for r in (client.get(f"{URL}/audience", headers=chair.headers), post(client, chair)):
        assert (r.status_code, code(r)) == (404, "bot_api_disabled"), r.text
    assert post(client, member).status_code == 403  # the right is checked first
    assert [i["broadcast_id"] for i in client.get(URL, headers=chair.headers).json()["items"]] == [made]
    assert client.get(f"{URL}/{made}", headers=member.headers).status_code == 200
    r = client.post(f"{URL}/{made}/cancel", headers=chair.headers)
    assert r.status_code == 200 and r.json()["state"] == "cancelled"
    assert stored()[0] == 1


def test_the_audience_counts_every_active_account_and_the_list(client, enabled, team, make_user):
    """`total` is every active account, the author included; `reachable` the VK list of a send."""
    chair = team["chair"]
    r = client.get(f"{URL}/audience", headers=chair.headers)
    assert r.json() == {"total": 6, "reachable": 0}  # chair, deputy, it, other, member, outsider
    linked(chair.user_id, 2200)  # the author is a recipient when their VK takes messages
    linked(team["member"].user_id, 2201, token="missing")
    linked(team["it"].user_id, 2202, messages=False)
    banned, pending = make_user(), make_user()
    linked(banned.user_id, 2203)
    linked(pending.user_id, 2204)
    db.update_user(banned.user_id, banned=True)
    db.update_user(pending.user_id, account_state="pending")
    with sql() as statements:
        data = client.get(f"{URL}/audience", headers=chair.headers).json()
    assert data == {"total": 6, "reachable": 2}
    assert len([s for s in statements if "bot_links" in s]) == 1
    sent = send(client, chair)
    assert counts(client, chair, sent["broadcast_id"])["total"] == 2


# ───────────────────────────── the text ─────────────────────────────

@pytest.mark.parametrize("payload,field", [
    ({"text": ""}, "text"), ({"text": " \n\t "}, "text"), ({"text": "я" * 4001}, "text"), ({}, "text"),
    ({"text": 5}, "text"), ({"text": "x", "extra": 1}, "extra"), ({"text": "x", "idempotency_key": "nope"}, "idempotency_key"),
])
def test_a_bad_body_is_422_in_the_field_format(client, enabled, chair, payload, field):
    crowd(1, 2301)
    r = client.post(URL, headers=chair.headers, json=payload)
    assert (r.status_code, code(r)) == (422, "validation_error"), r.text
    assert any(e["loc"] == ["body", field] for e in r.json()["detail"]["fields"]["errors"]), r.json()
    assert stored() == [0, 0, 0, 0, 0]


def test_the_text_is_trimmed_keeps_its_lines_and_4000_fits(client, enabled, chair):
    crowd(1, 2401)
    data = send(client, chair, "\n  Первая строка\n\n  вторая  \n ")
    assert data["text"] == "Первая строка\n\n  вторая"
    longest = send(client, chair, "  " + "я" * 4000 + "\n")
    assert len(longest["text"]) == 4000


def test_the_same_key_returns_the_same_broadcast_other_text_is_409(client, enabled, team, sender):
    linked(team["member"].user_id, 2501)
    key = str(uuid.uuid4())
    first = send(client, team["chair"], "Текст", key)
    before = stored()
    again = send(client, team["chair"], " Текст ", key.upper())  # the same text after trimming, the same UUID
    assert again == first and stored() == before
    for actor, text in ((team["chair"], "Другой текст"), (sender, "Текст")):
        r = post(client, actor, text, key)
        assert (r.status_code, code(r)) == (409, "duplicate_request_key"), r.text
    assert stored() == before
    # Without a key every request is a new broadcast.
    assert send(client, team["chair"], "Текст")["broadcast_id"] != first["broadcast_id"]


def test_nobody_to_reach_in_vk_is_409_and_leaves_nothing(client, enabled, chair):
    crowd(1, 2601, state="messages_denied")
    r = post(client, chair, key=str(uuid.uuid4()))
    assert (r.status_code, code(r)) == (409, "broadcast_no_recipients"), r.text
    assert stored() == [0, 0, 0, 0, 0]


# ───────────────────────────── the recipients ─────────────────────────────

def test_the_list_is_fixed_at_send(client, enabled, chair, make_user):
    linked(chair.user_id, 3000)  # the author, sendable
    people = {name: make_user(name=name) for name in ("ok", "missing", "invalid", "denied", "unlinked", "banned", "pending", "gone")}
    for vk, (name, token, messages) in enumerate((("ok", "ok", True), ("missing", "missing", True), ("invalid", "invalid", True),
                                                  ("denied", "ok", False), ("banned", "ok", True), ("pending", "ok", True),
                                                  ("gone", "ok", True)), 3001):
        linked(people[name].user_id, vk, messages=messages, token=token)
    db.update_user(people["banned"].user_id, banned=True)
    db.update_user(people["pending"].user_id, account_state="pending")
    archive(client, chair, people["gone"])
    sent = send(client, chair)
    bid = sent["broadcast_id"]
    expected = {chair.user_id: 3000, people["ok"].user_id: 3001, people["missing"].user_id: 3002, people["invalid"].user_id: 3003}
    assert {uid: r["vk"] for uid, r in recipients(bid).items()} == expected
    # Later: a new link is not added, a relink keeps the remembered VK, an archive keeps the recipient.
    linked(people["unlinked"].user_id, 3010)
    with db._session() as s:
        link = s.get(BotLinkORM, people["ok"].user_id)
        link.vk_user_id = 3011
        bot_api.save_link(s, s.get(UserORM, people["ok"].user_id), link)
        s.commit()
    archive(client, chair, people["missing"])
    [batch] = poll(client)
    assert batch["peer_ids"] == [expected[uid] for uid in sorted(expected)]
    assert counts(client, chair, bid) == tally(total=4, pending=4)


def test_batches_of_100_in_user_id_order(client, enabled, chair):
    people = crowd(250, 40000)
    sent = send(client, chair, "Пачки")
    bid = sent["broadcast_id"]
    rows = batches(bid)
    assert [b["batch_id"] for b in rows] == [f"{bid}-{i:04d}" for i in range(3)]
    assert all((b["state"], b["attempts"], b["created_at"], b["next_attempt_at"]) == ("pending", 0, rows[0]["created_at"],
                                                                                         rows[0]["created_at"]) for b in rows)
    stored_rows = recipients(bid)
    for i, (uid, vk) in enumerate(sorted(people)):
        assert (stored_rows[uid]["batch"], stored_rows[uid]["vk"], stored_rows[uid]["state"]) == (f"{bid}-{i // 100:04d}", vk, "pending")
    handed = poll(client, limit=1)  # `limit` is for deliveries
    assert [b["batch_id"] for b in handed] == [b["batch_id"] for b in rows]
    assert [len(b["peer_ids"]) for b in handed] == [100, 100, 50]
    assert [p for b in handed for p in b["peer_ids"]] == [vk for _, vk in sorted(people)]
    for b in handed:
        assert set(b) == {"broadcast_id", "batch_id", "text", "peer_ids", "random_id", "created_at"}
        assert (b["broadcast_id"], b["text"], b["created_at"], b["random_id"]) == (bid, "Пачки", sent["created_at"],
                                                                                    random_id(b["batch_id"]))
        assert 1 <= b["random_id"] < 2**31
    assert sent["created_at"].endswith("Z") and len(sent["created_at"]) == 20
    assert poll(client) == handed  # nothing is marked at hand-out


# ───────────────────────────── the bell ─────────────────────────────

def test_every_active_account_but_the_author_gets_the_bell(client, enabled, team, make_user):
    chair, member = team["chair"], team["member"]
    linked(team["it"].user_id, 4001)
    banned, pending, gone = make_user(), make_user(), make_user()
    db.update_user(banned.user_id, banned=True)
    db.update_user(pending.user_id, account_state="pending")
    archive(client, chair, gone)
    sent = send(client, chair, "\n   \n  Первая строка рассылки  \nвторая строка")
    bid = sent["broadcast_id"]
    with db._session() as s:
        notes = s.query(NotificationORM).filter_by(kind="broadcast").all()
        assert {n.user_id for n in notes} == {team[w].user_id for w in ("deputy", "it", "other", "member", "outsider")}
        assert {(n.event_key, json.loads(n.payload_json)["broadcast_id"], json.loads(n.payload_json)["title"]) for n in notes} == {
            (f"broadcast:{bid}", bid, "Первая строка рассылки")}
        assert len({n.notification_id for n in notes}) == len(notes) and all(not n.is_read for n in notes)
        assert s.query(DeliveryORM).count() == 0  # no outbox row: a broadcast reaches VK only as itself
    assert delivery_category("broadcast") is None
    [note] = bell(client, member)  # without VK too
    assert (note["text"], note["target"]) == ("Рассылка: Первая строка рассылки", {"kind": "broadcast", "id": bid})
    assert bell(client, chair) == []
    assert client.get(f"{URL}/{bid}", headers=member.headers).json()["text"] == "Первая строка рассылки  \nвторая строка"
    long = send(client, chair, "д" * 150 + "\nещё")
    newest = bell(client, member)[0]
    assert newest["text"] == "Рассылка: " + "д" * 99 + "…" and newest["target"]["id"] == long["broadcast_id"]
    assert broadcasts.title("x" * 100) == "x" * 100 and len(broadcasts.title("x" * 101)) == 100


def test_the_bell_is_never_revoked_for_an_active_account(client, enabled, team):
    linked(team["member"].user_id, 4101)
    sent = send(client, team["chair"])
    client.post(f"{URL}/{sent['broadcast_id']}/cancel", headers=team["chair"].headers).raise_for_status()
    for who in ("member", "it", "deputy"):
        [note] = bell(client, team[who])
        assert note["kind"] == "broadcast" and note["target"] == {"kind": "broadcast", "id": sent["broadcast_id"]}, who
    assert bot_api.target_path(note["target"]) == f"/broadcasts/{sent['broadcast_id']}"


# ───────────────────────────── GET /work ─────────────────────────────

def test_work_hands_out_at_most_5_due_batches_oldest_first(client, enabled, chair):
    crowd(700, 50000)
    first = send(client, chair, "Первая")["broadcast_id"]
    second = send(client, chair, "Вторая")["broadcast_id"]
    handed = poll(client)
    assert [b["batch_id"] for b in handed] == [f"{first}-{i:04d}" for i in range(5)]
    report(client, *(entry(b) for b in handed))
    handed = poll(client)
    assert [b["batch_id"] for b in handed] == [f"{first}-{i:04d}" for i in (5, 6)] + [f"{second}-{i:04d}" for i in range(3)]
    # Not due yet, or over 24 hours old: not handed out.
    shift_batches(second, next_attempt_at=iso(datetime.now(timezone.utc) + timedelta(minutes=1)))
    assert {b["broadcast_id"] for b in poll(client)} == {first}
    shift_batches(first, created_at=iso(datetime.now(timezone.utc) - timedelta(hours=24, seconds=1)))
    due(second)
    assert {b["broadcast_id"] for b in poll(client)} == {second}


def test_random_id_is_stable_and_never_zero():
    assert bot_api.random_id("b-0000") == random_id("b-0000")
    assert all(1 <= bot_api.random_id(f"{uuid.uuid4()}-{i:04d}") < 2**31 for i in range(200))


# ───────────────────────────── POST /report ─────────────────────────────

def test_each_result_applies_to_its_recipient(client, enabled, chair):
    people = crowd(7, 60000)
    bid = send(client, chair)["broadcast_id"]
    [batch] = poll(client)
    p = batch["peer_ids"]
    report(client, entry(batch,
                         outcome(p[0], "sent", vk_message_id=77), outcome(p[1], "sent"), outcome(p[2], "denied", error_code=901),
                         outcome(p[3], "failed", error_code=902), outcome(p[4], "failed", error_code=10, retryable=True),
                         outcome(p[5], "failed", error_code="missing"), outcome(p[0], "failed", error_code=1),  # the first counts
                         outcome(99999, "sent"), outcome(p[6], "weird")),  # unknown peer, unknown status: skipped
           {"batch_id": "unknown", "results": [outcome(p[6], "sent")]})
    states = {vk: (r["state"], r["message"], r["error"]) for r in recipients(bid).values() for vk in [r["vk"]]}
    assert states == {p[0]: ("sent", 77, None), p[1]: ("sent", None, None), p[2]: ("denied", None, "901"),
                      p[3]: ("failed", None, "902"), p[4]: ("pending", None, "10"), p[5]: ("failed", None, "missing"),
                      p[6]: ("pending", None, None)}
    [b] = batches(bid)
    assert (b["state"], b["attempts"]) == ("pending", 1)
    wait = datetime.fromisoformat(b["next_attempt_at"]) - datetime.now(timezone.utc)
    assert timedelta(seconds=50) < wait <= timedelta(minutes=1)
    # denied: the link of that VK takes no messages any more.
    uid = next(u for u, vk in people if vk == p[2])
    with db._session() as s:
        assert (s.get(BotLinkORM, uid).messages_allowed, s.get(UserORM, uid).bot_link_state) == (False, "messages_denied")
    assert counts(client, chair, bid) == tally(total=7, pending=2, sent=2, denied=1, failed=2)
    assert row(bid)["state"] == "sending"
    # The retry goes to the recipients left, with the same random_id.
    assert poll(client) == []
    due(bid)
    [again] = poll(client)
    assert (again["batch_id"], again["random_id"], again["peer_ids"]) == (batch["batch_id"], batch["random_id"], [p[4], p[6]])
    report(client, entry(again))
    assert row(bid)["state"] == "done" and batches(bid)[0]["state"] == "done"
    assert counts(client, chair, bid) == tally(total=7, sent=4, denied=1, failed=2)


def test_a_repeated_report_changes_nothing(client, enabled, chair):
    crowd(2, 61000)
    bid = send(client, chair)["broadcast_id"]
    [batch] = poll(client)
    payload = body(hb=None, broadcasts=[entry(batch, outcome(batch["peer_ids"][0], "failed", error_code=6, retryable=True))])
    assert client.post(REPORT, headers=BOT, json=payload).json()["duplicate"] is False
    before = (recipients(bid), batches(bid))
    assert client.post(REPORT, headers=BOT, json=payload).json()["duplicate"] is True
    assert (recipients(bid), batches(bid)) == before


def test_retries_wait_1_5_30_120_minutes_then_the_rest_fail(client, enabled, chair):
    crowd(2, 62000)
    bid = send(client, chair)["broadcast_id"]
    [batch] = poll(client)
    for attempt, minutes in enumerate((1, 5, 30, 120), 1):
        report(client, entry(batch, status="failed", error_code="network", retryable=True))
        [b] = batches(bid)
        wait = datetime.fromisoformat(b["next_attempt_at"]) - datetime.now(timezone.utc)
        assert (b["state"], b["attempts"]) == ("pending", attempt)
        assert timedelta(minutes=minutes) - timedelta(seconds=10) < wait <= timedelta(minutes=minutes)
        due(bid)
        [again] = poll(client)
        assert again == batch
    report(client, entry(batch, outcome(batch["peer_ids"][0], "sent", vk_message_id=5),
                         outcome(batch["peer_ids"][1], "failed", error_code=6, retryable=True)))
    [b] = batches(bid)
    assert (b["state"], b["attempts"]) == ("done", 5)
    assert sorted((r["state"], r["error"]) for r in recipients(bid).values()) == [("failed", "6"), ("sent", None)]
    assert row(bid)["state"] == "done"
    assert poll(client) == []


def test_the_fifth_attempt_fails_a_recipient_without_a_result_with_its_last_error(client, enabled, chair):
    crowd(2, 63000)
    bid = send(client, chair)["broadcast_id"]
    [batch] = poll(client)
    first, second = batch["peer_ids"]
    report(client, entry(batch, outcome(second, "failed", error_code=9, retryable=True)))
    shift_batches(bid, attempts=4)
    report(client, entry(batch, outcome(first, "failed", error_code=14, retryable=True)))
    assert {r["vk"]: (r["state"], r["error"]) for r in recipients(bid).values()} == {first: ("failed", "14"), second: ("failed", "9")}


def test_a_sent_message_beats_the_cancellation(client, enabled, chair):
    crowd(4, 64000)
    bid = send(client, chair)["broadcast_id"]
    [batch] = poll(client)
    cancelled = client.post(f"{URL}/{bid}/cancel", headers=chair.headers).json()
    assert cancelled["counts"] == tally(total=4, cancelled=4)
    p = batch["peer_ids"]
    report(client, entry(batch, outcome(p[0], "sent", vk_message_id=1), outcome(p[1], "denied", error_code=901),
                         outcome(p[2], "failed", error_code=10, retryable=True), outcome(p[3], "failed", error_code=902)))
    assert {r["vk"]: r["state"] for r in recipients(bid).values()} == {p[0]: "sent", p[1]: "denied", p[2]: "cancelled", p[3]: "failed"}
    assert (row(bid)["state"], batches(bid)[0]["state"], batches(bid)[0]["attempts"]) == ("cancelled", "cancelled", 0)
    assert counts(client, chair, bid) == tally(total=4, sent=1, denied=1, failed=1, cancelled=1)
    assert poll(client) == []


def test_a_batch_without_pending_recipients_is_skipped_and_closed_by_the_next_report(client, enabled, chair):
    crowd(150, 65000)
    bid = send(client, chair)["broadcast_id"]
    first, second = (b["batch_id"] for b in batches(bid))
    with db._session() as s:  # as a retention would leave it
        s.query(BroadcastRecipientORM).filter_by(batch_id=first).delete()
        s.commit()
    with sql() as statements:
        handed = poll(client)
    assert [b["batch_id"] for b in handed] == [second] and len(statements) == 3
    assert bot_api.EMPTY.snapshot() == [first]
    assert [b["batch_id"] for b in poll(client)] == [second]  # the held batch takes no place
    report(client)  # no results: the held batch is closed
    assert [b["state"] for b in batches(bid)] == ["done", "pending"] and row(bid)["state"] == "sending"
    assert bot_api.EMPTY.snapshot() == []
    report(client, entry(handed[0]))
    assert [b["state"] for b in batches(bid)] == ["done", "done"] and row(bid)["state"] == "done"


def test_a_broadcast_left_without_recipients_is_done(client, enabled, chair):
    crowd(3, 66000)
    bid = send(client, chair)["broadcast_id"]
    with db._session() as s:
        s.query(BroadcastRecipientORM).delete()
        s.commit()
    assert poll(client) == []
    report(client)
    assert (row(bid)["state"], batches(bid)[0]["state"]) == ("done", "done")


@pytest.mark.parametrize("change", [
    lambda b: b.update(broadcasts=[{"batch_id": f"b{i}", "results": []} for i in range(11)]),
    lambda b: b.update(broadcasts=[{"batch_id": "b", "results": [outcome(1 + i) for i in range(101)]}]),
    lambda b: b.update(broadcasts=[{"batch_id": "b", "results": [outcome(0)]}]),
    lambda b: b.update(broadcasts=[{"batch_id": "", "results": []}]),
    lambda b: b.update(broadcasts=[{"results": []}]),
])
def test_report_schema_of_batches(client, enabled, change):
    payload = body(hb=None)
    change(payload)
    r = client.post(REPORT, headers=BOT, json=payload)
    assert (r.status_code, code(r)) == (422, "validation_error"), r.text


def test_unknown_fields_of_a_batch_result_are_skipped(client, enabled, chair):
    crowd(1, 67000)
    bid = send(client, chair)["broadcast_id"]
    [batch] = poll(client)
    report(client, {**entry(batch, outcome(batch["peer_ids"][0]) | {"extra": 1}), "later": True})
    assert row(bid)["state"] == "done"


# ───────────────────────────── expiry and cancel ─────────────────────────────

def test_the_hourly_pass_expires_batches_pending_for_24_hours(client, enabled, chair):
    crowd(150, 68000)
    old = send(client, chair, "Старая")["broadcast_id"]
    fresh = send(client, chair, "Свежая")["broadcast_id"]
    shift_batches(old, created_at=iso(datetime.now(timezone.utc) - timedelta(hours=25)))
    assert {b["broadcast_id"] for b in poll(client)} == {fresh}
    report(client)  # the first report runs the hourly pass
    assert [b["state"] for b in batches(old)] == ["expired", "expired"] and row(old)["state"] == "done"
    assert counts(client, chair, old) == tally(total=150, expired=150)
    assert [b["state"] for b in batches(fresh)] == ["pending", "pending"] and row(fresh)["state"] == "sending"


def test_cancel_stops_what_is_pending_and_keeps_the_bell(client, enabled, team, sender):
    crowd(150, 69000)
    linked(team["member"].user_id, 69500)
    bid = send(client, team["chair"])["broadcast_id"]
    first = poll(client)[0]
    report(client, entry(first))
    r = client.post(f"{URL}/{bid}/cancel", headers=sender.headers)  # any sender cancels
    assert r.status_code == 200, r.text
    data = r.json()
    assert (data["state"], data["counts"]) == ("cancelled", tally(total=151, sent=100, cancelled=51))
    assert data["cancelled_at"].endswith("Z") and row(bid)["cancelled_by_user_id"] == sender.user_id
    assert [b["state"] for b in batches(bid)] == ["done", "cancelled"]
    assert audits("broadcast_cancel") == [("broadcast", bid, sender.user_id, {"state": "sending"}, {"state": "cancelled", "cancelled": 51})]
    assert len(bell(client, team["member"])) == 1
    assert poll(client) == []
    again = client.post(f"{URL}/{bid}/cancel", headers=team["chair"].headers)
    assert (again.status_code, code(again)) == (409, "broadcast_not_sending")
    missing = client.post(f"{URL}/{uuid.uuid4()}/cancel", headers=team["chair"].headers)
    assert missing.status_code == 404


def test_a_finished_broadcast_is_not_cancelled(client, enabled, chair):
    crowd(1, 70000)
    bid = send(client, chair)["broadcast_id"]
    report(client, entry(poll(client)[0]))
    r = client.post(f"{URL}/{bid}/cancel", headers=chair.headers)
    assert (r.status_code, code(r)) == (409, "broadcast_not_sending")
    assert row(bid)["state"] == "done" and row(bid)["cancelled_at"] is None


def test_send_and_cancel_are_audited(client, enabled, chair):
    crowd(3, 71000)
    sent = send(client, chair)
    assert audits("broadcast_send") == [("broadcast", sent["broadcast_id"], chair.user_id, {},
                                         {"state": "sending", "recipients": 3, "notified": 3})]


# ───────────────────────────── reading ─────────────────────────────

def test_the_list_pages_newest_first_with_counts(client, enabled, team, sender):
    crowd(3, 72000)
    authors = [team["chair"], team["deputy"], sender]
    made = [send(client, authors[i % 3], f"Рассылка {i}")["broadcast_id"] for i in range(23)]
    client.post(f"{URL}/{made[0]}/cancel", headers=team["chair"].headers).raise_for_status()
    first = client.get(URL, headers=team["deputy"].headers).json()
    assert [i["broadcast_id"] for i in first["items"]] == made[::-1][:20] and first["next_cursor"]
    second = client.get(URL, headers=team["deputy"].headers, params={"cursor": first["next_cursor"]}).json()
    assert [i["broadcast_id"] for i in second["items"]] == made[::-1][20:] and second["next_cursor"] is None
    oldest = second["items"][-1]
    assert set(oldest) == {"broadcast_id", "text", "author", "created_at", "state", "cancelled_at", "counts"}
    assert (oldest["text"], oldest["state"], oldest["counts"]) == ("Рассылка 0", "cancelled", tally(total=3, cancelled=3))
    assert oldest["author"]["user_id"] == team["chair"].user_id and oldest["author"]["display_name"]
    assert first["items"][0]["author"]["user_id"] == authors[22 % 3].user_id
    assert all(i["counts"] == tally(total=3, pending=3) and i["state"] == "sending" for i in first["items"])
    r = client.get(URL, headers=team["chair"].headers, params={"cursor": "not-a-cursor"})
    assert (r.status_code, code(r)) == (422, "invalid_input")


def test_an_ordinary_account_reads_the_text_without_counts(client, enabled, team):
    crowd(2, 73000)
    sent = send(client, team["chair"], "Полный текст\nрассылки")
    r = client.get(f"{URL}/{sent['broadcast_id']}", headers=team["member"].headers)
    assert r.status_code == 200
    assert r.json() == {**sent, "counts": None}
    assert sent["author"] == {"user_id": team["chair"].user_id, "display_name": sent["author"]["display_name"],
                              "avatar_url": sent["author"]["avatar_url"]}
    missing = client.get(f"{URL}/{uuid.uuid4()}", headers=team["member"].headers)
    assert (missing.status_code, code(missing)) == (404, "not_found")


# ───────────────────────────── retention ─────────────────────────────

def test_retention_removes_the_recipient_and_the_author_archive_keeps_them(client, enabled, team, sender):
    from account_cleanup import purge

    member, other = team["member"], team["other"]
    linked(member.user_id, 74001)
    linked(other.user_id, 74002)
    bid = send(client, sender)["broadcast_id"]
    client.post(f"{URL}/{bid}/cancel", headers=sender.headers).raise_for_status()
    archive(client, team["chair"], member)
    archive(client, team["chair"], sender)
    assert set(recipients(bid)) == {member.user_id, other.user_id}
    assert (row(bid)["author_user_id"], row(bid)["cancelled_by_user_id"]) == (sender.user_id, sender.user_id)
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 2
    assert set(recipients(bid)) == {other.user_id}
    assert (row(bid)["author_user_id"], row(bid)["cancelled_by_user_id"]) == (None, None)
    page = client.get(f"{URL}/{bid}", headers=team["chair"].headers).json()
    assert page["author"] is None and page["text"] and page["counts"] == tally(total=1, cancelled=1)


# ───────────────────────────── the old schema ─────────────────────────────

def test_an_old_database_gains_the_broadcast_tables_twice(tmp_path):
    path = tmp_path / "old-broadcasts.db"
    root = Path(__file__).resolve().parents[1]
    env = {**__import__("os").environ, "DATABASE_PATH": str(path)}
    subprocess.run([sys.executable, "-c", "import database"], cwd=root, env=env, check=True, capture_output=True)
    with sqlite3.connect(path) as c:
        for table in ("broadcast_recipients", "broadcast_batches", "broadcasts"):
            c.execute(f"DROP TABLE {table}")
        c.execute("INSERT INTO users (user_id, hashed_password, kkr_score, group_number, blocks, banned, super_user, admin) "
                  "VALUES (7, '', 0, '101', '', 0, 0, 0)")
    script = ("import json, database; from sqlalchemy import text; c = database.engine.connect(); "
              "tables = sorted(r[0] for r in c.execute(text(\"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'broadcast%'\"))); "
              "index = c.execute(text(\"SELECT sql FROM sqlite_master WHERE name = 'ix_broadcast_batches_pending'\")).scalar(); "
              "unique = c.execute(text(\"SELECT sql FROM sqlite_master WHERE name = 'ux_broadcasts_idempotency_key'\")).scalar(); "
              "users = c.execute(text('SELECT count(*) FROM users')).scalar(); "
              "c.close(); print(json.dumps([tables, index, unique, users]))")
    for _ in range(2):
        out = subprocess.run([sys.executable, "-c", script], cwd=root, env=env, check=True, capture_output=True, text=True)
        tables, index, unique, users = json.loads(out.stdout.strip().splitlines()[-1])
        assert tables == ["broadcast_batches", "broadcast_recipients", "broadcasts"] and users == 1
        assert "(next_attempt_at, created_at)" in index and "WHERE state = 'pending'" in index
        assert "UNIQUE" in unique and "(idempotency_key)" in unique
    with sqlite3.connect(path) as c:
        assert c.execute("PRAGMA quick_check").fetchone()[0] == "ok"


# ───────────────────────────── the statement budget ─────────────────────────────

def _plan(statement, parameters):
    with engine.connect() as c:
        return [str(r[-1]) for r in c.exec_driver_sql("EXPLAIN QUERY PLAN " + statement, parameters)]


def _seen(call):
    seen = []

    def keep(_conn, _cursor, statement, parameters, *_):
        seen.append((statement, parameters))
    event.listen(engine, "before_cursor_execute", keep)
    try:
        result = call()
    finally:
        event.remove(engine, "before_cursor_execute", keep)
    return result, seen


def test_an_idle_poll_is_two_selects_over_the_partial_indexes(client, enabled, chair):
    crowd(1, 75000)
    bid = send(client, chair)["broadcast_id"]
    report(client, entry(poll(client)[0]))
    assert row(bid)["state"] == "done"
    for held in ([], ["held-0000"]):  # held empty batches are part of the same statement
        bot_api.EMPTY.add(held)
        handed, seen = _seen(lambda: poll(client))
        assert handed == [] and len(seen) == 2, seen
        statement, parameters = seen[1]
        assert "FROM broadcast_batches" in statement
        assert any("ix_broadcast_batches_pending" in step for step in _plan(statement, parameters))


def test_work_with_5_batches_is_three_selects(client, enabled, chair):
    crowd(600, 76000)
    send(client, chair)
    handed, seen = _seen(lambda: poll(client))
    assert len(handed) == 5 and sum(len(b["peer_ids"]) for b in handed) == 500
    assert len(seen) == 3 and all(s.lstrip().startswith("SELECT") for s, _ in seen), [s for s, _ in seen]
    assert any("ix_broadcast_recipients_batch_id" in step for step in _plan(*seen[2]))


def test_a_report_with_5_by_100_results_is_a_few_bulk_statements(client, enabled, chair):
    crowd(1000, 77000)
    bid = send(client, chair)["broadcast_id"]
    report(client)  # the first report's hourly pass, out of the count

    def count(entries):
        with sql() as statements:
            report(client, *entries)
        return statements
    handed = poll(client)
    statements = count([entry(b) for b in handed])
    # BEGIN, bot_status, the batches, their open recipients, one UPDATE (executemany) each of
    # the recipients, the batches and the broadcasts, then the flush of bot_status.
    assert len(statements) == 8, statements
    assert len([s for s in statements if s.startswith("UPDATE broadcast_recipients")]) == 1
    assert len([s for s in statements if s.lstrip().startswith("SELECT") and "FROM broadcast_recipients" in s]) == 1
    assert [b["state"] for b in batches(bid)[:5]] == ["done"] * 5
    # Denied answers add one read of the links with their accounts and their writes.
    handed = poll(client)
    denied = count([entry(b, status="denied", error_code=901) for b in handed])
    assert len(denied) == 11, denied
    assert row(bid)["state"] == "done"


def test_a_send_costs_the_same_statements_for_3_or_300_recipients(client, enabled, chair):
    crowd(3, 78000)

    def count():
        with sql() as statements:
            send(client, chair)
        return len(statements)
    few = count()
    crowd(297, 78100)
    assert count() == few


def test_a_list_page_costs_the_same_for_1_or_20_broadcasts(client, enabled, team, sender):
    crowd(5, 79000)

    def count():
        with sql() as statements:
            r = client.get(URL, headers=team["chair"].headers)
        assert r.status_code == 200
        return len(statements), len(r.json()["items"])
    send(client, team["chair"])
    one, _ = count()
    for i in range(19):
        send(client, (team["chair"], team["deputy"], sender)[i % 3])
    assert count() == (one, 20)


def test_session_and_the_bell_count_cost_no_more_with_broadcasts(client, enabled, team):
    member = team["member"]

    def count():
        totals = []
        for path in ("/api/session", "/api/notifications/unread-count"):
            with sql() as statements:
                assert client.get(path, headers=member.headers).status_code == 200
            totals.append(len(statements))
        return totals
    before = count()
    crowd(50, 80000)
    send(client, team["chair"])
    assert count() == before
