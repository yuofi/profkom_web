"""HereBot stage 1 (backend/docs/BOT_API.md, decisions of 2026-11-04).

The service API /api/bot/v1: the token check without the database, disabled/401/413/422,
the idle work queue in one SELECT, reports (heartbeat, error groups, dedup, truncation,
retention, the statement budget). The people's side: console status, the IT master by the
block name "IT", maintainers and broadcast senders as `site` role assignments, their
capabilities, audit, archive and restore.
"""
import hashlib
import json
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy import event

import access
import bot_api
from bot_models import BotErrorORM, BotStatusORM
from database import AuditLogORM, RoleAssignmentORM, db, engine
from settings import Settings, settings

TOKEN, OTHER = "t" * 43, "o" * 43
HASH, OTHER_HASH = (hashlib.sha256(t.encode()).hexdigest() for t in (TOKEN, OTHER))
BOT = {"Authorization": f"Bearer {TOKEN}"}
WORK, REPORT = "/api/bot/v1/work", "/api/bot/v1/report"


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)


@contextmanager
def sql():
    statements = []

    def count(_conn, _cursor, statement, *_):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        yield statements
    finally:
        event.remove(engine, "before_cursor_execute", count)


def at(minutes=0.0, days=0.0):
    return bot_api.stamp(datetime.now(timezone.utc) + timedelta(minutes=minutes, days=days))


def heartbeat(**kw):
    return {"version": "2.3.0", "commit": "abc1234", "started_at": at(-1), "interval_s": 60, "stopping": False,
            "components": {"longpoll": 4, "scheduler": 12, "site": 0}, "longpoll_connected": True,
            "database": "postgresql", "counters": {"chats": 3, "delayed_pending": 0, "delayed_failed": 0, "tokens": 5}, **kw}


def group(fingerprint="0f3a9c2d4e5b6a70", **kw):
    return {"fingerprint": fingerprint, "level": "ERROR", "logger": "root", "where": "_scheduler_loop",
            "message": "Critical error in the scheduler loop", "traceback": "Traceback (most recent call last): …",
            "count": 3, "first_at": at(-1), "last_at": at(-0.5), **kw}


def body(hb=True, errors=(), **kw):
    return {"api": 1, "report_id": uuid.uuid4().hex, "boot_id": kw.pop("boot_id", "4be0" * 8),
            "heartbeat": heartbeat() if hb is True else hb, "errors": list(errors), **kw}


def post(client, payload, headers=BOT):
    return client.post(REPORT, json=payload, headers=headers)


def code(response):
    return response.json()["detail"]["code"]


def status_row():
    with db._session() as s:
        row = s.get(BotStatusORM, 1)
        return None if row is None else {c.name: getattr(row, c.name) for c in BotStatusORM.__table__.columns}


def error_rows():
    with db._session() as s:
        return {r.fingerprint: {c.name: getattr(r, c.name) for c in BotErrorORM.__table__.columns}
                for r in s.query(BotErrorORM)}


# ───────────────────────────── settings ─────────────────────────────

@pytest.mark.parametrize("value,stored", [("", ""), (HASH, HASH), (f" {HASH} , {OTHER_HASH} ", f"{HASH},{OTHER_HASH}")])
def test_setting_takes_up_to_two_lowercase_hashes(value, stored):
    assert Settings(BOT_API_TOKEN_SHA256=value).BOT_API_TOKEN_SHA256 == stored


@pytest.mark.parametrize("value", [HASH.upper(), HASH[:-1], TOKEN, f"{HASH},{OTHER_HASH},{HASH}", f"{HASH},"])
def test_setting_refuses_anything_else(value):
    with pytest.raises(ValidationError):
        Settings(BOT_API_TOKEN_SHA256=value)


# ───────────────────────────── access to the service API ─────────────────────────────

def test_disabled_integration_answers_404_bot_api_disabled(client, make_user):
    assert settings.BOT_API_TOKEN_SHA256 == ""
    user = make_user()
    for method, path in (("GET", WORK), ("POST", REPORT)):
        for headers in ({}, BOT, user.headers):
            r = client.request(method, path, json=body() if method == "POST" else None, headers=headers)
            assert (r.status_code, code(r)) == (404, "bot_api_disabled"), (method, headers, r.text)


@pytest.mark.parametrize("header", [None, "", "Bearer", f"Basic {TOKEN}", "Bearer wrong", f"Bearer {TOKEN}x", f"bearer {OTHER}"])
def test_missing_or_wrong_token_answers_401_without_sql(client, enabled, header):
    headers = {} if header is None else {"Authorization": header}
    with sql() as statements:
        responses = [client.get(WORK, headers=headers), client.post(REPORT, json=body(), headers=headers)]
    for r in responses:
        assert (r.status_code, code(r)) == (401, "bot_token_invalid"), r.text
        assert set(r.json()["detail"]) == {"code", "message", "fields"}
    assert statements == []
    assert status_row() is None


def test_a_user_session_is_not_a_service_token(client, enabled, superuser):
    r = client.get(WORK, headers=superuser.headers)
    assert (r.status_code, code(r)) == (401, "bot_token_invalid")


def test_rotation_accepts_both_configured_tokens(client, monkeypatch):
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", f"{OTHER_HASH},{HASH}")
    for token in (TOKEN, OTHER):
        assert client.get(WORK, headers={"Authorization": f"Bearer {token}"}).status_code == 200
    third = client.get(WORK, headers={"Authorization": "Bearer " + "x" * 43})
    assert third.status_code == 401


# ───────────────────────────── GET /work ─────────────────────────────

def test_idle_work_is_empty_and_three_selects(client, enabled):
    """Stage 5 reads the pause and the open commands, stage 3 the VK queue, stage 4 the
    batches of broadcasts: an idle poll is three SELECTs (their indexes: test_bot_console,
    test_bot_notify, test_bot_broadcasts)."""
    with sql() as statements:
        r = client.get(WORK, headers=BOT)
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(data) == {"api", "server_time", "poll_after_ms", "paused", "deliveries", "broadcasts", "commands"}
    assert (data["api"], data["poll_after_ms"], data["paused"]) == (1, 3000, False)
    assert data["deliveries"] == data["broadcasts"] == data["commands"] == []
    server = datetime.strptime(data["server_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert abs((server - datetime.now(timezone.utc)).total_seconds()) < 5
    assert len(statements) == 3 and all(s.lstrip().startswith("SELECT") for s in statements), statements


@pytest.mark.parametrize("limit,status", [(1, 200), (100, 200), (0, 422), (101, 422), ("x", 422)])
def test_work_limit_is_1_to_100(client, enabled, limit, status):
    r = client.get(WORK, params={"limit": limit}, headers=BOT)
    assert r.status_code == status
    if status == 422:
        assert code(r) == "validation_error"


# ───────────────────────────── POST /report: limits and schema ─────────────────────────────

def test_body_over_256_kib_is_refused_by_length_and_by_actual_bytes(client, enabled):
    big = json.dumps(body(padding="x" * (256 * 1024))).encode()
    r = client.post(REPORT, content=big, headers={**BOT, "Content-Type": "application/json"})
    assert (r.status_code, code(r)) == (413, "payload_too_large")
    # A chunked body names no length: the received bytes are counted.
    r = client.post(REPORT, content=iter([big[:1000], big[1000:]]), headers={**BOT, "Content-Type": "application/json"})
    assert "content-length" not in {k.lower() for k in r.request.headers}
    assert (r.status_code, code(r)) == (413, "payload_too_large")
    assert status_row() is None
    # Just under the limit is read normally.
    fits = body(padding="x" * (256 * 1024 - 2000))
    raw = json.dumps(fits).encode()
    assert len(raw) <= 256 * 1024
    assert client.post(REPORT, content=iter([raw]), headers={**BOT, "Content-Type": "application/json"}).status_code == 200


@pytest.mark.parametrize("change", [
    lambda b: b.pop("report_id"),
    lambda b: b.update(report_id="not-hex"),
    lambda b: b.update(boot_id="ABC"),
    lambda b: b.update(api=2),
    lambda b: b.update(errors=[group(fingerprint=f"{i:016x}") for i in range(51)]),
    lambda b: b.update(errors=[group(fingerprint="xyz")]),
    lambda b: b.update(errors=[group(count=0)]),
    lambda b: b["heartbeat"].update(interval_s=0),
    lambda b: b["heartbeat"].pop("started_at"),
    lambda b: b["heartbeat"].update(components={f"c{i}": 1 for i in range(33)}),
])
def test_schema_errors_answer_422(client, enabled, change):
    payload = body()
    change(payload)
    r = post(client, payload)
    assert (r.status_code, code(r)) == (422, "validation_error"), r.text
    assert status_row() is None


def test_broken_json_answers_422(client, enabled):
    r = client.post(REPORT, content=b"{not json", headers={**BOT, "Content-Type": "application/json"})
    assert (r.status_code, code(r)) == (422, "validation_error")


def test_unknown_fields_of_later_stages_are_skipped(client, enabled):
    payload = body(errors=[group(extra="x")], deliveries=[{"delivery_id": "d", "status": "sent"}],
                   vk_events=[{"vk_user_id": 1, "event": "message_allow", "at": at()}], future={"a": 1})
    payload["heartbeat"]["later"] = {"channel": "stable"}  # stage 5 stores `updates` (test_bot_console)
    r = post(client, payload)
    assert r.status_code == 200, r.text
    stored = json.loads(status_row()["heartbeat_json"])
    assert "later" not in stored and "updates" not in stored and stored["version"] == "2.3.0"
    assert "extra" not in error_rows()["0f3a9c2d4e5b6a70"]


# ───────────────────────────── POST /report: storage ─────────────────────────────

def test_report_stores_the_heartbeat_and_answers_the_contract(client, enabled):
    payload = body()
    r = post(client, payload)
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(data) == {"api", "accepted", "duplicate", "server_time"}
    assert (data["api"], data["accepted"], data["duplicate"]) == (1, True, False)
    row = status_row()
    assert (row["report_id"], row["boot_id"], row["started_at"]) == (payload["report_id"], payload["boot_id"],
                                                                     payload["heartbeat"]["started_at"])
    assert row["last_seen_at"] == row["updated_at"] == data["server_time"]
    assert json.loads(row["heartbeat_json"]) == payload["heartbeat"]
    # A results-only report keeps the last heartbeat and moves last_seen_at.
    r = post(client, body(hb=None, boot_id="5" * 32))
    assert r.status_code == 200
    after = status_row()
    assert after["heartbeat_json"] == row["heartbeat_json"] and after["boot_id"] == "5" * 32


def test_repeat_of_the_last_report_is_a_duplicate_and_changes_nothing(client, enabled):
    payload = body(errors=[group()])
    assert post(client, payload).json()["duplicate"] is False
    before = (status_row(), error_rows())
    with sql() as statements:
        r = post(client, payload)
    assert r.status_code == 200 and r.json() == {**r.json(), "accepted": True, "duplicate": True}
    assert (status_row(), error_rows()) == before
    assert len(statements) == 2  # BEGIN IMMEDIATE and the status row
    # Another report_id is new again.
    assert post(client, {**payload, "report_id": uuid.uuid4().hex}).json()["duplicate"] is False
    assert error_rows()["0f3a9c2d4e5b6a70"]["count"] == 6


def test_error_groups_are_upserted_by_fingerprint(client, enabled):
    first = group(count=3, first_at=at(-10), last_at=at(-9), message="first text", traceback="tb 1")
    post(client, body(errors=[first]))
    later = group(count=2, first_at=at(-20), last_at=at(-1), message="second text", traceback=None)
    other = group(fingerprint="1" * 16, level="WARNING", logger="vk", where="poll", count=1)
    post(client, body(errors=[later, other]))
    rows = error_rows()
    g = rows["0f3a9c2d4e5b6a70"]
    assert (g["count"], g["first_at"], g["last_at"]) == (5, later["first_at"], later["last_at"])
    assert (g["message"], g["traceback"], g["location"]) == ("second text", None, "_scheduler_loop")
    assert (rows["1" * 16]["level"], rows["1" * 16]["logger"], rows["1" * 16]["location"]) == ("WARNING", "vk", "poll")
    # The same fingerprint twice in one report is one group.
    post(client, body(errors=[group(count=1), group(count=4, message="third")]))
    g = error_rows()["0f3a9c2d4e5b6a70"]
    assert (g["count"], g["message"]) == (10, "third")


def test_the_site_truncates_long_texts(client, enabled):
    long = group(message="м" * 1500, traceback="t" * 9000, logger="l" * 300, where="w" * 300)
    assert post(client, body(errors=[long])).status_code == 200
    g = error_rows()["0f3a9c2d4e5b6a70"]
    assert (len(g["message"]), len(g["traceback"]), len(g["logger"]), len(g["location"])) == (1000, 8000, 200, 200)


def test_heartbeat_only_report_takes_at_most_three_statements(client, enabled):
    post(client, body(errors=[group()]))  # the first report also runs the hourly retention
    with sql() as statements:
        r = post(client, body())
    assert r.status_code == 200
    assert len(statements) <= 3, statements
    assert [s.split()[0].upper() for s in statements] == ["BEGIN", "SELECT", "UPDATE"]


def _seed_groups(count, last_at):
    with db._session() as s:
        for i in range(count):
            s.add(BotErrorORM(fingerprint=f"{i:016x}", level="ERROR", logger="", location="", message="m",
                              count=1, first_at=last_at(i), last_at=last_at(i)))
        s.commit()


def _cleaned(at_text):
    with db._session() as s:
        row = s.get(BotStatusORM, 1)
        row.cleaned_at = at_text
        s.commit()


def test_retention_keeps_the_newest_500_groups_and_30_days_at_most_hourly(client, enabled):
    post(client, body())  # creates the status row and runs the first pass
    _seed_groups(520, lambda i: at(minutes=-i))
    with db._session() as s:
        s.add(BotErrorORM(fingerprint="a" * 16, level="ERROR", logger="", location="", message="old", count=1,
                          first_at=at(days=-40), last_at=at(days=-31)))
        s.commit()
    _cleaned(at(minutes=-30))
    post(client, body())  # the last pass was 30 minutes ago: nothing is cleaned
    assert len(error_rows()) == 521
    _cleaned(at(minutes=-61))
    post(client, body())
    rows = error_rows()
    assert len(rows) == 500 and "a" * 16 not in rows
    assert set(rows) == {f"{i:016x}" for i in range(500)}  # the newest by last_at
    assert status_row()["cleaned_at"] >= at(minutes=-1)


def test_a_report_adding_groups_keeps_the_cap_at_once(client, enabled):
    post(client, body())
    _cleaned(at())
    _seed_groups(495, lambda i: at(days=-1, minutes=-i))
    post(client, body(errors=[group(fingerprint=f"{i:016x}".replace("0", "f", 1)) for i in range(10)]))
    rows = error_rows()
    assert len(rows) == 500
    assert all(f"{i:016x}".replace("0", "f", 1) in rows for i in range(10))  # the new ones are the newest


# ───────────────────────────── the console and the grants ─────────────────────────────

@pytest.fixture
def team(client, make_user, make_block, superuser):
    """The chair, a chair deputy, the master of the block "IT", the master of another block,
    a member of "IT" and an outsider."""
    people = {"chair": superuser}
    for who in ("deputy", "it", "other", "member", "outsider"):
        people[who] = make_user(name=who, surname=f"Бот{who.capitalize()}")
    lead = client.get("/api/leadership", headers=superuser.headers).json()
    client.put("/api/leadership/deputies", json={"user_ids": [people["deputy"].user_id], "expected_revision": lead["revision"]},
               headers=superuser.headers).raise_for_status()
    make_block(name="IT")
    make_block(name="ИТ-поддержка")
    blocks = {b["name"]: b for b in client.get("/api/blocks", headers=superuser.headers).json()}
    for name, who in (("IT", "it"), ("ИТ-поддержка", "other")):
        client.put(f"/api/blocks/{blocks[name]['block_id']}/leader",
                   json={"user_id": people[who].user_id, "expected_revision": blocks[name]["revision"]},
                   headers=superuser.headers).raise_for_status()
    people["blocks"] = {name: b["block_id"] for name, b in blocks.items()}
    return people


def caps(client, actor):
    r = client.get("/api/session", headers=actor.headers)
    assert r.status_code == 200, r.text
    return set(r.json()["capabilities"])


BOT_CAPS = {"view_bot_console", "operate_bot", "manage_bot_maintainers"}
BROADCAST_CAPS = {"send_broadcast", "manage_broadcast_senders"}


def test_it_master_by_block_name_owns_the_console_the_chair_does_not(client, team):
    expected = {"chair": BROADCAST_CAPS, "deputy": BROADCAST_CAPS, "it": BOT_CAPS, "other": set(), "member": set(), "outsider": set()}
    for who, want in expected.items():
        assert caps(client, team[who]) & (BOT_CAPS | BROADCAST_CAPS) == want, who
        status = client.get("/api/bot/console/status", headers=team[who].headers).status_code
        assert status == (200 if who == "it" else 403), who
        assert client.get("/api/bot/maintainers", headers=team[who].headers).status_code == status, who
        assert client.get("/api/broadcasts/senders", headers=team[who].headers).status_code == (
            200 if who in ("chair", "deputy") else 403), who
    assert access.IT_MASTER in access.relations(team["it"].user_id)
    assert access.IT_MASTER not in access.relations(team["other"].user_id)


def test_maintainers_are_granted_by_the_it_master_with_audit(client, team):
    it, member = team["it"], team["member"]
    url = f"/api/bot/maintainers/{member.user_id}"
    for who in ("chair", "deputy", "other", "member"):
        r = client.put(url, json={"maintainer": True}, headers=team[who].headers)
        assert r.status_code == 403, who
    audits = lambda: [(a.target_kind, a.target_id, a.reason, a.old_values_json, a.new_values_json, a.changed_by_user_id)  # noqa: E731
                      for a in db._session().query(AuditLogORM).filter_by(target_kind="user", reason="bot_maintainer")]
    r = client.put(url, json={"maintainer": True}, headers=it.headers)
    assert r.json() == {"user_id": member.user_id, "maintainer": True}
    assert client.put(url, json={"maintainer": True}, headers=it.headers).status_code == 200  # idempotent
    assert audits() == [("user", str(member.user_id), "bot_maintainer", '{"bot_maintainer": false}',
                         '{"bot_maintainer": true}', it.user_id)]
    with db._session() as s:
        rows = [(r.role, r.scope_kind, r.scope_id, r.principal_assignment_id) for r in s.query(RoleAssignmentORM).filter_by(user_id=member.user_id)]
    assert rows == [("bot_maintainer", "site", None, None)]
    # The maintainer reads the console and the list, does not manage it.
    assert caps(client, member) & (BOT_CAPS | BROADCAST_CAPS) == {"view_bot_console", "operate_bot"}
    listing = client.get("/api/bot/maintainers", headers=member.headers).json()
    assert [i["user_id"] for i in listing["items"]] == [member.user_id] and listing["items"][0]["display_name"]
    assert client.put(f"/api/bot/maintainers/{team['outsider'].user_id}", json={"maintainer": True},
                      headers=member.headers).status_code == 403
    # Session assignments list the site row honestly, without capabilities of its own.
    session = client.get("/api/session", headers=member.headers).json()
    site = [a for a in session["assignments"] if a["scope_kind"] == "site"]
    assert [(a["role"], a["scope_id"], a["capabilities"]) for a in site] == [("bot_maintainer", None, [])]
    # Revoke, then a repeated revoke: one more audit entry, no error.
    for _ in range(2):
        r = client.put(url, json={"maintainer": False}, headers=it.headers)
        assert r.json() == {"user_id": member.user_id, "maintainer": False}
    assert len(audits()) == 2
    assert caps(client, member) & BOT_CAPS == set()
    assert client.get("/api/bot/console/status", headers=member.headers).status_code == 403


def test_only_active_accounts_are_granted_revoking_always_works(client, team, make_user):
    it, chair = team["it"], team["chair"]
    pending = make_user(name="pending", surname="Ожидающий")
    db.update_user(pending.user_id, account_state="pending")
    for path, field, actor in (("bot/maintainers", "maintainer", it), ("broadcasts/senders", "sender", chair)):
        assert client.put(f"/api/{path}/{pending.user_id}", json={field: True}, headers=actor.headers).status_code == 404
        assert client.put(f"/api/{path}/999999", json={field: True}, headers=actor.headers).status_code == 404
        assert client.put(f"/api/{path}/999999", json={field: False}, headers=actor.headers).status_code == 404
        assert client.put(f"/api/{path}/{pending.user_id}", json={field: False}, headers=actor.headers).json() == {
            "user_id": pending.user_id, field: False}
        assert client.put(f"/api/{path}/{pending.user_id}", json={field: True, "x": 1}, headers=actor.headers).status_code == 422


def test_broadcast_senders_are_granted_by_the_chair_and_deputies(client, team):
    outsider = team["outsider"]
    url = f"/api/broadcasts/senders/{outsider.user_id}"
    for who in ("it", "other", "outsider"):
        assert client.put(url, json={"sender": True}, headers=team[who].headers).status_code == 403, who
    assert client.put(url, json={"sender": True}, headers=team["deputy"].headers).json() == {"user_id": outsider.user_id, "sender": True}
    assert caps(client, outsider) & (BOT_CAPS | BROADCAST_CAPS) == {"send_broadcast"}
    assert [i["user_id"] for i in client.get("/api/broadcasts/senders", headers=team["chair"].headers).json()["items"]] == [outsider.user_id]
    assert client.get("/api/bot/console/status", headers=outsider.headers).status_code == 403
    assert client.put(url, json={"sender": False}, headers=team["chair"].headers).json()["sender"] is False
    assert caps(client, outsider) & BROADCAST_CAPS == set()
    with db._session() as s:
        assert s.query(AuditLogORM).filter_by(target_kind="user", reason="broadcaster").count() == 2


def test_renaming_the_it_block_moves_the_console_maintainers_keep_it(client, team):
    it, member, chair = team["it"], team["member"], team["chair"]
    client.put(f"/api/bot/maintainers/{member.user_id}", json={"maintainer": True}, headers=it.headers).raise_for_status()
    block = client.get(f"/api/blocks/{team['blocks']['IT']}", headers=chair.headers).json()
    client.patch(f"/api/blocks/{block['block_id']}", json={"expected_revision": block["revision"], "name": "IT-old"},
                 headers=chair.headers).raise_for_status()
    assert caps(client, it) & BOT_CAPS == set()
    assert client.get("/api/bot/console/status", headers=it.headers).status_code == 403
    assert caps(client, member) & BOT_CAPS == {"view_bot_console", "operate_bot"}
    # A new master of the block named IT manages the inherited list.
    block = client.get(f"/api/blocks/{team['blocks']['ИТ-поддержка']}", headers=chair.headers).json()
    client.patch(f"/api/blocks/{block['block_id']}", json={"expected_revision": block["revision"], "name": "IT"},
                 headers=chair.headers).raise_for_status()
    assert caps(client, team["other"]) & BOT_CAPS == BOT_CAPS
    r = client.put(f"/api/bot/maintainers/{member.user_id}", json={"maintainer": False}, headers=team["other"].headers)
    assert r.json()["maintainer"] is False


def test_archive_removes_site_grants_and_restore_does_not_bring_them_back(client, team):
    it, member, chair = team["it"], team["member"], team["chair"]
    client.put(f"/api/bot/maintainers/{member.user_id}", json={"maintainer": True}, headers=it.headers).raise_for_status()
    client.put(f"/api/broadcasts/senders/{member.user_id}", json={"sender": True}, headers=chair.headers).raise_for_status()
    with db._session() as s:
        ids = sorted(r.role_assignment_id for r in s.query(RoleAssignmentORM).filter_by(user_id=member.user_id, scope_kind="site"))
    assert len(ids) == 2
    client.post(f"/api/accounts/{member.user_id}/archive", json={"reason": "Выпуск"}, headers=chair.headers).raise_for_status()
    with db._session() as s:
        assert s.query(RoleAssignmentORM).filter_by(user_id=member.user_id).count() == 0
    assert access.relations(member.user_id) == frozenset()
    assert client.get("/api/bot/maintainers", headers=it.headers).json()["items"] == []
    restored = client.post(f"/api/accounts/{member.user_id}/restore", json={}, headers=chair.headers)
    assert restored.status_code == 200, restored.text
    assert set(ids) <= set(restored.json()["skipped_assignment_ids"])
    with db._session() as s:
        assert s.query(RoleAssignmentORM).filter_by(user_id=member.user_id, scope_kind="site").count() == 0


def _status(client, actor):
    r = client.get("/api/bot/console/status", headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()


def _seen(seconds_ago):
    with db._session() as s:
        s.get(BotStatusORM, 1).last_seen_at = bot_api.stamp(datetime.now(timezone.utc) - timedelta(seconds=seconds_ago))
        s.commit()


def test_console_status_online_offline_and_errors(client, team, monkeypatch):
    it = team["it"]
    data = _status(client, it)
    assert data == {"enabled": False, "online": False, "last_seen_at": None, "boot_id": None, "heartbeat": None, "errors": []}
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    assert _status(client, it)["enabled"] is True and _status(client, it)["online"] is False
    _seed_groups(150, lambda i: at(minutes=-100 - i))  # fingerprints 0…149, older
    groups = [group(fingerprint=f"{i + 1000:016x}", last_at=at(minutes=-i), first_at=at(minutes=-i - 1)) for i in range(50)]
    payload = body(errors=groups)
    post(client, payload).raise_for_status()
    data = _status(client, it)
    assert (data["online"], data["boot_id"], data["heartbeat"]) == (True, payload["boot_id"], payload["heartbeat"])
    assert len(data["errors"]) == 100
    assert [e["last_at"] for e in data["errors"]] == sorted((e["last_at"] for e in data["errors"]), reverse=True)
    assert {e["fingerprint"] for e in data["errors"]} == {g["fingerprint"] for g in groups} | {f"{i:016x}" for i in range(50)}
    assert data["errors"][0] == {**{k: groups[0][k] for k in ("fingerprint", "level", "logger", "where", "message", "traceback",
                                                             "count", "first_at", "last_at")}}
    # max(3 × 60, 180) = 180 seconds
    _seen(170)
    assert _status(client, it)["online"] is True
    _seen(190)
    assert _status(client, it)["online"] is False
    post(client, body(hb=heartbeat(interval_s=120))).raise_for_status()  # 360 seconds
    _seen(300)
    assert _status(client, it)["online"] is True
    _seen(370)
    assert _status(client, it)["online"] is False
    post(client, body(hb=heartbeat(stopping=True))).raise_for_status()
    assert _status(client, it)["online"] is False
    post(client, body()).raise_for_status()
    assert _status(client, it)["online"] is True
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", "")
    assert _status(client, it)["enabled"] is False and _status(client, it)["online"] is False


def test_it_master_relation_costs_no_sql_on_session(client, team):
    """The relation comes from the same block snapshot as the other master checks."""
    it, chair = team["it"], team["chair"]

    def count():
        with sql() as statements:
            assert client.get("/api/session", headers=it.headers).status_code == 200
        return len(statements)
    as_it_master = count()
    assert caps(client, it) & BOT_CAPS == BOT_CAPS
    block = client.get(f"/api/blocks/{team['blocks']['IT']}", headers=chair.headers).json()
    client.patch(f"/api/blocks/{block['block_id']}", json={"expected_revision": block["revision"], "name": "Не IT"},
                 headers=chair.headers).raise_for_status()
    assert caps(client, it) & BOT_CAPS == set()
    assert count() == as_it_master
