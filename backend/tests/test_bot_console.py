"""HereBot stage 5: the bot console (backend/docs/BOT_API.md, «Консоль бота»).

Who reads and operates it; the integration off; the pause (its row, audit, repeats, GET /work
while paused); the status (pause, queue, heartbeat.updates and its limits); creating commands
(kinds and args, defaults, the bot offline, one open command per slot, the VK the update
requests need, the restart limit, the idempotency key, audit); GET /work (selection, terms,
order, the cap of 10, requested_by); POST /report (the state machine, order within a report,
unknown ids and statuses, clipping, the output of `logs`); expiry on read and the hourly pass;
the history and one command; retention; the additive schema on an old database twice; and the
statement budget (idle /work three SELECTs and one while paused, a report with results two
more, the status and a command creation constant).
"""
import json
import secrets
import sqlite3
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import event

import bot_api
from bot_link import iso, stamp
from bot_models import BotCommandORM, BotStatusORM
from database import AuditLogORM, db, engine
from settings import settings
from test_bot_api import BOT, HASH, at, body, code, heartbeat, sql, team  # noqa: F401
from test_bot_broadcasts import crowd, send
from test_bot_notify import emit, linked, notify, ready
from test_retention_release_criteria import archive

URL, WORK, REPORT = "/api/bot/console", "/api/bot/v1/work", "/api/bot/v1/report"
OUT = {"command_id", "kind", "args", "state", "code", "message", "requested_by", "created_at", "updated_at",
       "finished_at", "has_output", "output"}
LOGS = {"lines": 200, "level": None, "contains": None}
UPDATES = {
    "remote": "on",
    "check": {"status": "available", "checked_at": "2026-11-05T08:00:00Z", "running": "2.4.0", "target": "2.5.0",
              "newer_major": "", "blocked": "", "previous": "2.3.0", "rollback": "bot", "error_kind": ""},
    "changelog": {"version": "2.5.0", "from": "2.4.0", "truncated": False, "text": "Исправления"},
    "job": {"id": "j1", "source": "bot", "action": "update", "state": "ok", "phase": "done", "reason": "",
            "from": "2.4.0", "to": "2.5.0", "running": "2.5.0", "rolled_back": False,
            "started_at": "2026-11-05T08:01:00Z", "updated_at": "2026-11-05T08:02:00Z"},
}


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
def it(team):
    return team["it"]


@pytest.fixture
def maintainer(client, team):
    """The member of `team`, made a bot maintainer by the IT master."""
    client.put(f"/api/bot/maintainers/{team['member'].user_id}", json={"maintainer": True},
               headers=team["it"].headers).raise_for_status()
    return team["member"]


@pytest.fixture
def online(client, enabled):
    """The bot has just reported a heartbeat (the first report's hourly pass included)."""
    beat(client)


# ───────────────────────────── helpers ─────────────────────────────

def beat(client, **hb):
    r = client.post(REPORT, headers=BOT, json=body(hb=heartbeat(**hb)))
    assert r.status_code == 200, r.text
    return r.json()


def report(client, *results, hb=None, raw=False):
    payload = body(hb=hb, commands=list(results))
    if raw:  # UTF-8 as is: the JSON escapes of httpx would triple a Cyrillic output
        return client.post(REPORT, headers={**BOT, "Content-Type": "application/json"},
                           content=json.dumps(payload, ensure_ascii=False).encode())
    r = client.post(REPORT, headers=BOT, json=payload)
    assert r.status_code == 200, r.text
    return r.json()


def outcome(command_id, status="done", code=None, message=None, output=None):
    return {"command_id": command_id, "status": status, "code": code, "message": message, "output": output}


def post(client, actor, kind="logs", args=None, key=None):
    payload = {"kind": kind, **({"args": args} if args is not None else {}), **({"idempotency_key": key} if key else {})}
    return client.post(f"{URL}/commands", headers=actor.headers, json=payload)


def make(client, actor, kind="logs", args=None, key=None):
    r = post(client, actor, kind, args, key)
    assert r.status_code == 200, r.text
    return r.json()


def pause(client, actor, paused=True):
    return client.put(f"{URL}/pause", headers=actor.headers, json={"paused": paused})


def status(client, actor):
    r = client.get(f"{URL}/status", headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()


def work(client):
    r = client.get(WORK, headers=BOT)
    assert r.status_code == 200, r.text
    return r.json()


def one(client, actor, command_id):
    r = client.get(f"{URL}/commands/{command_id}", headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()


def ago(minutes=0.0, hours=0.0, days=0.0):
    return iso(datetime.now(timezone.utc) - timedelta(minutes=minutes, hours=hours, days=days))


def seed(kind="logs", state="pending", created=None, **values):
    """A command written directly: `created` is its created_at (bot_link.iso), now by default."""
    when, cid = created or ago(), values.pop("command_id", secrets.token_hex(16))
    with db._session() as s:
        s.add(BotCommandORM(command_id=cid, kind=kind, args_json=json.dumps(values.pop("args", {})), state=state,
                            created_at=when, updated_at=values.pop("updated_at", when), **values))
        s.commit()
    return cid


def row(command_id):
    with db._session() as s:
        r = s.get(BotCommandORM, command_id)
        return None if r is None else {c.name: getattr(r, c.name) for c in BotCommandORM.__table__.columns}


def shift(command_id, **values):
    with db._session() as s:
        s.query(BotCommandORM).filter_by(command_id=command_id).update(values)
        s.commit()


def status_row():
    with db._session() as s:
        r = s.get(BotStatusORM, 1)
        return None if r is None else {c.name: getattr(r, c.name) for c in BotStatusORM.__table__.columns}


def set_status(**values):
    with db._session() as s:
        s.query(BotStatusORM).filter_by(id=1).update(values)
        s.commit()


def audits(*reasons):
    with db._session() as s:
        return [(a.reason, a.target_kind, a.target_id, a.changed_by_user_id, json.loads(a.old_values_json),
                 json.loads(a.new_values_json))
                for a in s.query(AuditLogORM).filter(AuditLogORM.reason.in_(reasons)).order_by(AuditLogORM.id)]


def stored():
    with db._session() as s:
        return s.query(BotCommandORM).count(), s.query(AuditLogORM).filter_by(target_kind="bot").count()


def handed(client):
    return [c["command_id"] for c in work(client)["commands"]]


# ───────────────────────────── who ─────────────────────────────

def test_the_it_master_and_maintainers_operate_the_console_others_do_not(client, online, team, maintainer):
    linked(team["it"].user_id, 1001)
    made = []
    for actor, kind in ((team["it"], "logs"), (maintainer, "restart")):
        assert status(client, actor)["enabled"] is True
        made.append(make(client, actor, kind)["command_id"])
        assert pause(client, actor, True).status_code == 200
        assert pause(client, actor, False).status_code == 200
        r = client.get(f"{URL}/commands", headers=actor.headers)
        assert r.status_code == 200 and {i["command_id"] for i in r.json()["items"]} == set(made)
        assert one(client, actor, made[0])["command_id"] == made[0]
    for who in ("chair", "deputy", "other", "outsider"):
        actor = team[who]
        for method, path, payload in (("GET", f"{URL}/status", None), ("PUT", f"{URL}/pause", {"paused": True}),
                                      ("POST", f"{URL}/commands", {"kind": "logs"}), ("GET", f"{URL}/commands", None),
                                      ("GET", f"{URL}/commands/{made[0]}", None),
                                      ("GET", f"{URL}/commands/{'0' * 32}", None)):
            r = client.request(method, path, headers=actor.headers, json=payload)
            assert (r.status_code, code(r)) == (403, "forbidden"), (who, method, path, r.text)
    assert stored() == (2, 6) and status_row()["paused"] is False
    caps = client.get("/api/session", headers=maintainer.headers).json()["capabilities"]
    assert {"view_bot_console", "operate_bot"} <= set(caps)


def test_with_the_integration_off_the_pause_and_commands_are_404_reading_works(client, team, it, monkeypatch):
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    beat(client)
    made = make(client, it)["command_id"]
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", "")
    for r in (pause(client, it), post(client, it), pause(client, it, False)):
        assert (r.status_code, code(r)) == (404, "bot_api_disabled"), r.text
    assert (pause(client, team["chair"]).status_code, post(client, team["outsider"]).status_code) == (403, 403)  # the right first
    assert status(client, it)["enabled"] is False
    assert [i["command_id"] for i in client.get(f"{URL}/commands", headers=it.headers).json()["items"]] == [made]
    assert one(client, it, made)["state"] == "pending"
    assert stored() == (1, 1) and status_row()["paused"] is False


# ───────────────────────────── the pause ─────────────────────────────

def test_the_pause_makes_the_status_row_and_only_a_change_is_audited(client, enabled, it, maintainer):
    r = pause(client, it, False)  # nothing to change: no row, no audit
    assert r.status_code == 200 and r.json()["paused"] is False
    assert status_row() is None and audits("bot_pause", "bot_resume") == []
    r = pause(client, it, True)
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(data) == {"enabled", "online", "last_seen_at", "boot_id", "heartbeat", "errors", "paused", "paused_at",
                         "paused_by", "queue"}
    assert (data["paused"], data["paused_by"]["user_id"]) == (True, it.user_id)
    assert data["paused_by"]["display_name"] and set(data["paused_by"]) == {"user_id", "display_name", "avatar_url"}
    assert data["paused_at"].endswith("Z") and data["paused_at"] >= at(-1)
    first = status_row()
    assert (first["paused"], first["paused_at"], first["paused_by_user_id"], first["report_id"]) == (
        True, data["paused_at"], it.user_id, None)
    again = pause(client, maintainer, True).json()  # a repeat by anyone changes nothing
    assert (again["paused_by"]["user_id"], again["paused_at"]) == (it.user_id, data["paused_at"]) and status_row() == first
    assert status(client, maintainer) == again
    resumed = pause(client, maintainer, False).json()
    assert (resumed["paused"], resumed["paused_at"], resumed["paused_by"]) == (False, None, None)
    assert pause(client, it, False).status_code == 200
    assert audits("bot_pause", "bot_resume") == [
        ("bot_pause", "bot", "pause", it.user_id, {"paused": False}, {"paused": True}),
        ("bot_resume", "bot", "pause", maintainer.user_id, {"paused": True}, {"paused": False})]


@pytest.mark.parametrize("payload", [{}, {"paused": "maybe"}, {"paused": None}, {"paused": True, "x": 1}])
def test_a_bad_pause_body_is_422(client, enabled, it, payload):
    r = client.put(f"{URL}/pause", headers=it.headers, json=payload)
    assert (r.status_code, code(r)) == (422, "validation_error"), r.text
    assert status_row() is None


def test_while_paused_work_hands_out_commands_only_and_the_report_keeps_the_pause(client, online, team, it, make_user):
    person = ready(make_user, 2001)
    notify([person.user_id])
    crowd(3, 2100)
    send(client, team["chair"])
    command = make(client, it)["command_id"]
    data = work(client)
    assert (data["paused"], len(data["deliveries"]), len(data["broadcasts"]), len(data["commands"])) == (False, 1, 1, 1)
    pause(client, it).raise_for_status()
    data = work(client)
    assert (data["paused"], data["deliveries"], data["broadcasts"]) == (True, [], [])
    assert [c["command_id"] for c in data["commands"]] == [command]
    beat(client)  # a report never touches the pause
    assert status_row()["paused"] is True and work(client)["paused"] is True
    queue = status(client, it)["queue"]
    assert queue == {"deliveries": 1, "batches": 1}  # the queue waits
    pause(client, it, False).raise_for_status()
    data = work(client)
    assert (data["paused"], len(data["deliveries"]), len(data["broadcasts"])) == (False, 1, 1)


# ───────────────────────────── the status ─────────────────────────────

def test_the_status_counts_the_queue_by_state(client, online, team, it, make_user):
    people = [ready(make_user, 2200 + i) for i in range(3)]
    notify([p.user_id for p in people])
    notify([people[0].user_id])
    [sent, *_] = work(client)["deliveries"]
    client.post(REPORT, headers=BOT, json=body(hb=None, deliveries=[
        {"delivery_id": sent["delivery_id"], "status": "sent", "vk_message_id": 1, "error_code": None,
         "retryable": False}])).raise_for_status()
    crowd(150, 2300)
    send(client, team["chair"])
    assert status(client, it)["queue"] == {"deliveries": 3, "batches": 2}  # pending rows of the VK channel only


def test_heartbeat_updates_are_kept_as_sent(client, online, it):
    beat(client, updates=UPDATES)
    data = status(client, it)
    assert data["heartbeat"]["updates"] == UPDATES and data["heartbeat"]["version"] == "2.3.0"
    beat(client, updates={"remote": None, "check": None, "changelog": None, "job": None})
    assert status(client, it)["heartbeat"]["updates"] == {"remote": None, "check": None, "changelog": None, "job": None}
    beat(client)  # a bot before stage 5: the heartbeat as before
    assert "updates" not in status(client, it)["heartbeat"]


@pytest.mark.parametrize("updates", ["on", ["a"], 5, None, {"text": "я" * 8200}])
def test_updates_not_an_object_or_over_16_kib_are_dropped_alone(client, online, it, updates):
    payload = body(hb=heartbeat(updates=updates, version="2.4.0"))
    r = client.post(REPORT, headers={**BOT, "Content-Type": "application/json"},
                    content=json.dumps(payload, ensure_ascii=False).encode())
    assert r.status_code == 200, r.text
    hb = status(client, it)["heartbeat"]
    assert "updates" not in hb and hb["version"] == "2.4.0"


def test_updates_of_exactly_16_kib_fit(client, online, it):
    base = {"text": ""}
    room = 16 * 1024 - len(json.dumps(base, separators=(",", ":")).encode())
    exact = {"text": "я" * (room // 2) + "x" * (room % 2)}
    assert len(json.dumps(exact, ensure_ascii=False, separators=(",", ":")).encode()) == 16 * 1024
    beat(client, updates=exact)
    assert status(client, it)["heartbeat"]["updates"] == exact


# ───────────────────────────── creating a command ─────────────────────────────

@pytest.mark.parametrize("payload,loc", [
    ({}, ["kind"]), ({"kind": "reboot"}, ["kind"]), ({"kind": "logs", "extra": 1}, ["extra"]),
    ({"kind": "logs", "args": None}, ["args"]), ({"kind": "logs", "args": []}, ["args"]),
    ({"kind": "logs", "args": {"lines": 0}}, ["args", "lines"]), ({"kind": "logs", "args": {"lines": 2001}}, ["args", "lines"]),
    ({"kind": "logs", "args": {"level": "TRACE"}}, ["args", "level"]), ({"kind": "logs", "args": {"contains": ""}}, ["args", "contains"]),
    ({"kind": "logs", "args": {"contains": "x" * 101}}, ["args", "contains"]), ({"kind": "logs", "args": {"since": 1}}, ["args", "since"]),
    ({"kind": "restart", "args": {"force": True}}, ["args", "force"]), ({"kind": "updates_check", "args": {"x": 1}}, ["args", "x"]),
    ({"kind": "update"}, ["args", "version"]), ({"kind": "update", "args": {"version": "2.5"}}, ["args", "version"]),
    ({"kind": "rollback", "args": {"version": "v2.3.0"}}, ["args", "version"]),
    ({"kind": "update", "args": {"version": "2.5.0", "x": 1}}, ["args", "x"]),
    ({"kind": "logs", "idempotency_key": "nope"}, ["idempotency_key"]),
])
def test_a_bad_command_is_422_in_the_field_format(client, online, it, payload, loc):
    r = client.post(f"{URL}/commands", headers=it.headers, json=payload)
    assert (r.status_code, code(r)) == (422, "validation_error"), r.text
    assert any(e["loc"] == ["body", *loc] for e in r.json()["detail"]["fields"]["errors"]), r.json()
    assert stored() == (0, 0)


def test_args_are_stored_with_their_defaults(client, online, it):
    linked(it.user_id, 3001)
    cases = ((("logs", None), LOGS), (("logs", {}), LOGS), (("logs", {"lines": 50}), {**LOGS, "lines": 50}),
             (("logs", {"lines": 2000, "level": "WARNING", "contains": "Ошибка"}),
              {"lines": 2000, "level": "WARNING", "contains": "Ошибка"}),
             (("restart", None), {}), (("updates_check", {}), {}), (("update", {"version": "2.5.0"}), {"version": "2.5.0"}),
             (("rollback", {"version": "2.3.10"}), {"version": "2.3.10"}))
    for (kind, args), want in cases:
        with db._session() as s:
            s.query(BotCommandORM).delete()
            s.commit()
        data = make(client, it, kind, args)
        assert data["args"] == want and json.loads(row(data["command_id"])["args_json"]) == want, (kind, args)
        assert work(client)["commands"][0]["args"] == want


def test_a_command_answers_command_out_and_the_bot_gets_its_requester(client, online, it, maintainer):
    linked(maintainer.user_id, 3101)
    data = make(client, maintainer, "updates_check")
    assert set(data) == OUT
    ref = data["requested_by"]
    assert (ref["user_id"], set(ref)) == (maintainer.user_id, {"user_id", "display_name", "avatar_url"}) and ref["display_name"]
    assert (data["kind"], data["args"], data["state"], data["code"], data["message"], data["finished_at"], data["has_output"],
            data["output"]) == ("updates_check", {}, "pending", None, None, None, False, None)
    assert len(data["command_id"]) == 32 and int(data["command_id"], 16) >= 0 and data["command_id"] == data["command_id"].lower()
    assert data["created_at"] == data["updated_at"] and data["created_at"].endswith("Z") and len(data["created_at"]) == 20
    [given] = work(client)["commands"]
    assert set(given) == {"command_id", "kind", "args", "requested_by", "created_at"}
    assert given == {"command_id": data["command_id"], "kind": "updates_check", "args": {}, "created_at": data["created_at"],
                     "requested_by": {"user_id": maintainer.user_id, "vk_user_id": 3101, "name": ref["display_name"]}}
    # Without a link the bot gets no VK; restart and logs do not need one.
    for kind in ("restart", "logs"):
        made = make(client, it, kind)
        assert made["requested_by"]["user_id"] == it.user_id
    requesters = {c["kind"]: c["requested_by"] for c in work(client)["commands"]}
    assert requesters["logs"]["vk_user_id"] is None and requesters["logs"]["name"] == one(
        client, it, made["command_id"])["requested_by"]["display_name"]
    assert row(data["command_id"])["requested_name"] == ref["display_name"]


def test_an_offline_bot_is_409(client, enabled, it):
    r = post(client, it)  # it has never reported
    assert (r.status_code, code(r)) == (409, "bot_offline"), r.text
    beat(client, stopping=True)
    assert code(post(client, it)) == "bot_offline"
    beat(client)
    set_status(last_seen_at=at(-4))  # max(3 × 60, 180) seconds have passed
    assert code(post(client, it)) == "bot_offline"
    assert stored() == (0, 0)
    set_status(last_seen_at=at(-2))
    assert post(client, it).status_code == 200


def test_one_open_command_per_kind_update_and_rollback_share_one(client, online, it):
    linked(it.user_id, 3201)
    first = {kind: make(client, it, kind, args)["command_id"]
             for kind, args in (("logs", None), ("restart", None), ("updates_check", None), ("update", {"version": "2.5.0"}))}
    for kind, args in (("logs", {"lines": 5}), ("restart", None), ("updates_check", None), ("update", {"version": "2.5.0"}),
                       ("rollback", {"version": "2.3.0"})):
        r = post(client, it, kind, args)
        assert (r.status_code, code(r)) == (409, "bot_command_pending"), (kind, r.text)
    report(client, outcome(first["logs"], "running"), outcome(first["update"], "running"))
    assert code(post(client, it, "logs")) == "bot_command_pending"  # running holds the slot too
    report(client, outcome(first["logs"]), outcome(first["update"], "failed", code="stale"))
    assert make(client, it, "logs")["state"] == "pending"
    assert make(client, it, "rollback", {"version": "2.3.0"})["state"] == "pending"
    assert stored()[0] == 6


def test_a_command_past_its_term_does_not_hold_the_slot(client, online, it):
    seed("logs", "pending", ago(minutes=9.9))
    assert code(post(client, it)) == "bot_command_pending"
    with db._session() as s:
        s.query(BotCommandORM).update({"created_at": ago(minutes=10.1)})
        s.commit()
    assert post(client, it).status_code == 200  # the old one reads as expired
    with db._session() as s:
        s.query(BotCommandORM).delete()
        s.commit()
    seed("restart", "running", ago(minutes=29.9))
    assert code(post(client, it, "restart")) == "bot_command_pending"
    with db._session() as s:
        s.query(BotCommandORM).update({"created_at": ago(minutes=30.1)})
        s.commit()
    assert post(client, it, "restart").status_code == 200


def test_the_update_requests_need_the_authors_vk(client, online, it):
    for kind, args in (("updates_check", None), ("update", {"version": "2.5.0"}), ("rollback", {"version": "2.3.0"})):
        r = post(client, it, kind, args)
        assert (r.status_code, code(r)) == (409, "bot_console_vk_required"), (kind, r.text)
    assert stored() == (0, 0)
    linked(it.user_id, 3301, messages=False, token="missing")  # any link names the VK
    made = make(client, it, "updates_check")
    assert [c["requested_by"]["vk_user_id"] for c in work(client)["commands"]] == [3301]
    assert row(made["command_id"])["requested_vk_user_id"] == 3301


def test_a_restart_waits_2_minutes_after_the_last_one(client, online, it):
    first = make(client, it, "restart")["command_id"]
    report(client, outcome(first))
    r = post(client, it, "restart")
    assert (r.status_code, code(r)) == (429, "bot_command_rate_limited"), r.text
    assert make(client, it, "logs")["kind"] == "logs"  # other kinds are not limited
    shift(first, created_at=ago(minutes=1.9))
    assert post(client, it, "restart").status_code == 429
    shift(first, created_at=ago(minutes=2.05))
    assert make(client, it, "restart")["state"] == "pending"


def test_the_same_key_returns_the_same_command_other_data_is_409(client, online, it, maintainer):
    key = str(uuid.uuid4())
    first = make(client, it, "logs", None, key)
    before = stored()
    assert make(client, it, "logs", {"lines": 200}, key.upper()) == first and stored() == before  # the same after defaults
    for actor, args in ((it, {"lines": 5}), (maintainer, None)):
        r = post(client, actor, "logs", args, key)
        assert (r.status_code, code(r)) == (409, "duplicate_request_key"), r.text
    assert code(post(client, it, "restart", None, key)) == "duplicate_request_key"
    # A repeat answers the command as it is now, even with the bot gone.
    report(client, outcome(first["command_id"], output="строка"))
    set_status(last_seen_at=at(-10))
    again = make(client, it, "logs", None, key)
    assert (again["command_id"], again["state"], again["output"]) == (first["command_id"], "done", "строка")
    assert stored() == before


def test_a_command_is_audited(client, online, it):
    linked(it.user_id, 3401)
    made = make(client, it, "update", {"version": "2.5.0"})
    logs = make(client, it, "logs", {"contains": "VK"})
    assert audits("bot_command") == [
        ("bot_command", "bot", made["command_id"], it.user_id, {}, {"kind": "update", "args": {"version": "2.5.0"}}),
        ("bot_command", "bot", logs["command_id"], it.user_id, {}, {"kind": "logs", "args": {**LOGS, "contains": "VK"}})]


# ───────────────────────────── GET /work ─────────────────────────────

def test_work_hands_out_at_most_10_open_commands_oldest_first_within_their_terms(client, enabled):
    young = [seed("logs", "pending", ago(minutes=5 - i / 60)) for i in range(10)]
    old_running = seed("update", "running", ago(minutes=29.5), args={"version": "2.5.0"})
    pending = seed("restart", "pending", ago(minutes=9.5))
    for state, minutes in (("pending", 10.5), ("running", 30.5), ("done", 1), ("failed", 1), ("unsupported", 1),
                           ("expired", 1)):
        seed("logs", state, ago(minutes=minutes))
    given = work(client)["commands"]
    assert [c["command_id"] for c in given] == [old_running, pending, *young[:8]]
    assert given[0]["args"] == {"version": "2.5.0"} and given[0]["created_at"] == stamp(
        datetime.fromisoformat(row(old_running)["created_at"]))
    assert work(client)["commands"] == given  # nothing is marked at hand-out
    report(client, *(outcome(c["command_id"]) for c in given[:5]))
    assert handed(client) == [*young[3:]]


def test_a_running_command_is_handed_out_until_its_result(client, online, it):
    made = make(client, it)["command_id"]
    report(client, outcome(made, "running", message="Ждёт ответа"))
    assert handed(client) == [made]
    report(client, outcome(made, "done"))
    assert handed(client) == []


# ───────────────────────────── POST /report ─────────────────────────────

def test_the_states_of_a_command(client, online, it):
    made = make(client, it)["command_id"]
    report(client, outcome(made, "running", code="busy", message="Читаю журнал"))
    r = row(made)
    assert (r["state"], r["code"], r["message"], r["finished_at"]) == ("running", "busy", "Читаю журнал", None)
    assert r["updated_at"] > r["created_at"]
    before = row(made)
    report(client, outcome(made, "running", message="Ещё раз"))  # running applies to pending only
    assert row(made) == before
    report(client, outcome(made, "failed", code="no_log", message="Нет файла журнала", output="ignored"))
    r = row(made)
    assert (r["state"], r["code"], r["message"], r["output"]) == ("failed", "no_log", "Нет файла журнала", "ignored")
    assert r["finished_at"] == r["updated_at"]
    done = row(made)
    for status_ in ("done", "unsupported", "running", "failed"):  # a finished command is final
        report(client, outcome(made, status_, message="позже"))
    assert row(made) == done
    data = one(client, it, made)
    assert (data["state"], data["code"], data["message"], data["has_output"], data["output"]) == (
        "failed", "no_log", "Нет файла журнала", True, "ignored")
    assert data["finished_at"].endswith("Z")


def test_the_results_of_one_report_apply_in_order(client, online, it):
    linked(it.user_id, 3501)
    a, b, c = (make(client, it, kind, args)["command_id"] for kind, args in (
        ("logs", None), ("restart", None), ("update", {"version": "2.5.0"})))
    report(client, outcome(a, "running"), outcome(a, "done", output="x"),  # running then the result: the result
           outcome(b, "done"), outcome(b, "running"),  # the result then running: the result
           outcome(c, "unsupported"), outcome(c, "failed", code="stale"))  # the first result wins
    assert (row(a)["state"], row(a)["output"], row(b)["state"], row(c)["state"], row(c)["code"]) == (
        "done", "x", "done", "unsupported", None)


def test_a_late_result_beats_the_expiry_running_does_not(client, enabled, it):
    shown = seed("logs", "pending", ago(minutes=11))  # expired on read, not yet marked
    marked = seed("logs", "expired", ago(minutes=40))  # marked by the hourly pass
    late = seed("logs", "running", ago(minutes=31))
    report(client, outcome(shown, "running"), outcome(marked, "running"), outcome(late, "running"))
    assert (row(shown)["state"], row(marked)["state"], row(late)["state"]) == ("expired", "expired", "expired")  # the pass ran too
    for cid in (shown, marked, late):
        report(client, outcome(cid, "done", output="поздно"))
        assert (row(cid)["state"], row(cid)["output"]) == ("done", "поздно"), cid


def test_unknown_commands_and_statuses_are_skipped_long_texts_are_cut(client, online, it):
    made = make(client, it)["command_id"]
    before = row(made)
    with sql() as statements:
        report(client, outcome("0" * 32), outcome("not-a-site-id"), {**outcome(made, "queued"), "extra": 1},
               outcome(made, "Done"))
    assert row(made) == before
    assert not [s for s in statements if s.startswith("UPDATE bot_commands")]
    report(client, outcome(made, "failed", code="c" * 80, message="м" * 700))
    r = row(made)
    assert (r["state"], r["code"], r["message"]) == ("failed", "c" * 64, "м" * 500)


@pytest.mark.parametrize("change", [
    lambda b: b.update(commands=[outcome(f"{i:032x}") for i in range(21)]),
    lambda b: b.update(commands=[{"status": "done"}]),
    lambda b: b.update(commands=[outcome("")]),
    lambda b: b.update(commands=[outcome("x" * 65)]),
    lambda b: b.update(commands=[{**outcome("a" * 32), "status": None}]),
    lambda b: b.update(commands=[{**outcome("a" * 32), "output": 5}]),
])
def test_report_schema_of_command_results(client, enabled, change):
    payload = body(hb=None)
    change(payload)
    r = client.post(REPORT, headers=BOT, json=payload)
    assert (r.status_code, code(r)) == (422, "validation_error"), r.text


def test_20_results_fit_in_a_report(client, enabled):
    ids = [seed("logs", created=ago(minutes=1 - i / 100)) for i in range(20)]
    report(client, *(outcome(cid) for cid in ids))
    assert {row(cid)["state"] for cid in ids} == {"done"}


def test_the_output_is_kept_for_logs_only_and_cut_to_its_last_128_kib(client, online, it):
    logs, restart = make(client, it)["command_id"], make(client, it, "restart")["command_id"]
    text = "я" * 70000 + "x"  # 140001 bytes: the cut falls inside a letter
    r = report(client, outcome(logs, output=text), outcome(restart, output="не журнал"), raw=True)
    assert r.status_code == 200, r.text
    kept = row(logs)["output"]
    assert kept == "я" * 65535 + "x" and len(kept.encode()) == 128 * 1024 - 1
    assert row(restart)["output"] is None
    exact = make(client, it)["command_id"]
    fits = "z" * (128 * 1024)
    report(client, outcome(exact, output=fits))
    assert row(exact)["output"] == fits


# ───────────────────────────── expiry ─────────────────────────────

def test_terms_read_as_expired_before_the_hourly_pass(client, online, it):
    pending, running = seed("logs", "pending", ago(minutes=10.1)), seed("restart", "running", ago(minutes=30.1))
    fresh = seed("updates_check", "pending", ago(minutes=9.9))
    assert one(client, it, pending)["state"] == "expired" and one(client, it, running)["state"] == "expired"
    items = {i["command_id"]: i["state"] for i in client.get(f"{URL}/commands", headers=it.headers).json()["items"]}
    assert items == {pending: "expired", running: "expired", fresh: "pending"}
    assert (row(pending)["state"], row(running)["state"]) == ("pending", "running")
    assert handed(client) == [fresh]


def test_the_hourly_pass_expires_wipes_old_outputs_and_keeps_500_for_30_days(client, enabled):
    beat(client)  # the first pass, on an empty table
    special = dict(
        p11=seed("logs", "pending", ago(minutes=11)), p9=seed("logs", "pending", ago(minutes=9)),
        r31=seed("restart", "running", ago(minutes=31)), r20=seed("restart", "running", ago(minutes=20)),
        out25=seed("logs", "done", ago(hours=25.1), output="старый", finished_at=ago(hours=25)),
        out23=seed("logs", "done", ago(hours=23.1), output="свежий", finished_at=ago(hours=23)),
        old=seed("logs", "done", ago(days=31), finished_at=ago(days=31)))
    filler = [seed("restart", "done", ago(days=2, minutes=i)) for i in range(505)]  # the newest first
    set_status(cleaned_at=at(-30))
    beat(client)  # within the hour: nothing
    assert (row(special["p11"])["state"], row(special["out25"])["output"]) == ("pending", "старый")
    set_status(cleaned_at=at(-61))
    with sql() as statements:
        beat(client)
    assert len([s for s in statements if "bot_commands" in s.split("WHERE")[0]]) == 3, statements
    states = {name: row(cid) for name, cid in special.items()}
    assert {name: r["state"] for name, r in states.items() if r} == {
        "p11": "expired", "p9": "pending", "r31": "expired", "r20": "running", "out25": "done", "out23": "done"}
    assert states["old"] is None
    assert (states["out25"]["output"], states["out23"]["output"]) == (None, "свежий")
    assert states["p11"]["updated_at"] >= ago(minutes=1) and states["p11"]["finished_at"] is None
    with db._session() as s:
        assert s.query(BotCommandORM).count() == 500
    assert [row(cid) is None for cid in filler] == [False] * 494 + [True] * 11


def test_the_output_reads_as_gone_after_24_hours(client, online, it):
    made = make(client, it)["command_id"]
    report(client, outcome(made, output="журнал"))
    assert (one(client, it, made)["has_output"], one(client, it, made)["output"]) == (True, "журнал")
    shift(made, finished_at=ago(hours=24.01))
    assert (one(client, it, made)["has_output"], one(client, it, made)["output"]) == (False, None)
    assert row(made)["output"] == "журнал"  # until the hourly pass


# ───────────────────────────── reading ─────────────────────────────

def test_the_history_pages_newest_first_without_outputs(client, online, it, maintainer):
    made = [seed("logs", "done", ago(minutes=60 - i), requested_by_user_id=(it, maintainer)[i % 2].user_id,
                 output=f"вывод {i}", finished_at=ago(minutes=60 - i)) for i in range(23)]
    first = client.get(f"{URL}/commands", headers=maintainer.headers).json()
    assert [i["command_id"] for i in first["items"]] == made[::-1][:20] and first["next_cursor"]
    second = client.get(f"{URL}/commands", headers=it.headers, params={"cursor": first["next_cursor"]}).json()
    assert [i["command_id"] for i in second["items"]] == made[::-1][20:] and second["next_cursor"] is None
    for item in first["items"] + second["items"]:
        assert set(item) == OUT and item["output"] is None and item["has_output"] is True
    newest = first["items"][0]
    assert newest["requested_by"]["user_id"] == (it, maintainer)[22 % 2].user_id and newest["state"] == "done"
    assert one(client, it, made[-1])["output"] == "вывод 22"
    r = client.get(f"{URL}/commands", headers=it.headers, params={"cursor": "not-a-cursor"})
    assert (r.status_code, code(r)) == (422, "invalid_input")
    missing = client.get(f"{URL}/commands/{'f' * 32}", headers=it.headers)
    assert (missing.status_code, code(missing)) == (404, "not_found")
    assert client.get(f"{URL}/commands", headers=it.headers).json() == first  # GET reads, never writes


def test_the_list_reads_no_output(client, online, it):
    for i in range(3):
        seed("logs", "done", ago(minutes=3 - i), output="ж" * 1000, finished_at=ago(minutes=1))
    with sql() as statements:
        assert client.get(f"{URL}/commands", headers=it.headers).status_code == 200
    [listing] = [s for s in statements if "FROM bot_commands" in s]
    assert "bot_commands.output IS NOT NULL" in listing and "bot_commands.output," not in listing


# ───────────────────────────── retention ─────────────────────────────

def test_retention_clears_the_requester_and_the_pause_author_archive_keeps_them(client, online, team, it, maintainer):
    from account_cleanup import purge

    linked(maintainer.user_id, 4001)
    mine, theirs = make(client, maintainer, "updates_check")["command_id"], make(client, it)["command_id"]
    pause(client, maintainer).raise_for_status()
    archive(client, team["chair"], maintainer)
    assert (row(mine)["requested_by_user_id"], row(mine)["requested_vk_user_id"]) == (maintainer.user_id, 4001)
    assert status_row()["paused_by_user_id"] == maintainer.user_id
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 1
    r = row(mine)
    assert (r["requested_by_user_id"], r["requested_vk_user_id"], r["requested_name"]) == (None, None, None)
    assert row(theirs)["requested_by_user_id"] == it.user_id and row(theirs)["requested_name"]
    assert (status_row()["paused"], status_row()["paused_by_user_id"]) == (True, None)
    data = status(client, it)
    assert (data["paused"], data["paused_by"]) == (True, None)
    assert one(client, it, mine)["requested_by"] is None
    by = {c["command_id"]: c["requested_by"] for c in work(client)["commands"]}
    assert by[mine] == {"user_id": None, "vk_user_id": None, "name": None}


# ───────────────────────────── the old schema ─────────────────────────────

STAGE_4_STATUS = ("CREATE TABLE bot_status (id INTEGER NOT NULL, boot_id VARCHAR, report_id VARCHAR, started_at VARCHAR, "
                  "last_seen_at VARCHAR, heartbeat_json TEXT, updated_at VARCHAR, cleaned_at VARCHAR, PRIMARY KEY (id))")


def test_an_old_database_gains_the_console_twice(tmp_path):
    path = tmp_path / "old-console.db"
    root = Path(__file__).resolve().parents[1]
    env = {**__import__("os").environ, "DATABASE_PATH": str(path)}
    subprocess.run([sys.executable, "-c", "import database"], cwd=root, env=env, check=True, capture_output=True)
    with sqlite3.connect(path) as c:
        c.execute("DROP TABLE bot_commands")
        c.execute("DROP TABLE bot_status")
        c.execute(STAGE_4_STATUS)
        c.execute("INSERT INTO bot_status (id, boot_id, report_id, last_seen_at, heartbeat_json) "
                  "VALUES (1, 'b', 'r', '2026-11-05T00:00:00Z', '{}')")
    script = ("import json, database, bot_api; from sqlalchemy import text; c = database.engine.connect(); "
              "cols = [r[1] for r in c.execute(text('PRAGMA table_info(bot_status)'))]; "
              "status = list(c.execute(text('SELECT boot_id, report_id, paused, paused_at, paused_by_user_id FROM bot_status')).one()); "
              "index = c.execute(text(\"SELECT sql FROM sqlite_master WHERE name = 'ix_bot_commands_open'\")).scalar(); "
              "unique = c.execute(text(\"SELECT sql FROM sqlite_master WHERE name = 'ux_bot_commands_idempotency_key'\")).scalar(); "
              "c.close(); now = bot_api.utcnow()\n"
              "with database.db.atomic(write=False): flags = bot_api.console_flags(now)\n"
              "print(json.dumps([[cols.count(n) for n in ('paused', 'paused_at', 'paused_by_user_id')], status, index, unique, flags]))")
    for _ in range(2):
        out = subprocess.run([sys.executable, "-c", script], cwd=root, env=env, check=True, capture_output=True, text=True)
        counts, status_, index, unique, flags = json.loads(out.stdout.strip().splitlines()[-1])
        assert counts == [1, 1, 1] and status_ == ["b", "r", 0, None, None] and flags == [False, False]
        assert "(created_at, command_id)" in index and "WHERE state IN ('pending', 'running')" in index
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


def test_an_idle_poll_is_three_selects_and_one_while_paused(client, online, it):
    for i in range(500):  # a full history, every command finished
        seed(("logs", "restart")[i % 2], "done", ago(minutes=60 + i))
    for paused, want in ((False, 3), (True, 1)):
        set_status(paused=paused)
        data, seen = _seen(lambda: work(client))
        assert (data["paused"], data["commands"]) == (paused, []) and len(seen) == want, [s for s, _ in seen]
        assert all(s.lstrip().startswith("SELECT") for s, _ in seen)
        statement, parameters = seen[0]
        assert "FROM bot_status" in statement and "FROM bot_commands" in statement
        plan = _plan(statement, parameters)
        assert any("ix_bot_commands_open" in step for step in plan) and not any("SCAN bot_commands" in s for s in plan), plan


def test_open_commands_add_one_select_over_the_partial_index(client, online, it):
    for i in range(500):
        seed("logs", "done", ago(minutes=60 + i))
    made = make(client, it)["command_id"]
    for paused, want in ((False, 4), (True, 2)):
        set_status(paused=paused)
        data, seen = _seen(lambda: work(client))
        assert [c["command_id"] for c in data["commands"]] == [made] and len(seen) == want, [s for s, _ in seen]
        statement, parameters = seen[1]
        assert statement.lstrip().startswith("SELECT") and "FROM bot_commands" in statement
        assert any("ix_bot_commands_open" in step for step in _plan(statement, parameters))


def test_a_report_with_command_results_is_two_statements_more(client, online, it):
    linked(it.user_id, 5001)
    made = [make(client, it, kind, args)["command_id"] for kind, args in (
        ("logs", None), ("restart", None), ("updates_check", None), ("update", {"version": "2.5.0"}))]
    pause(client, it).raise_for_status()

    def count(*results, hb=True):
        with sql() as statements:
            r = client.post(REPORT, headers=BOT, json=body(hb=heartbeat() if hb else None, commands=list(results)))
        assert r.status_code == 200, r.text
        return sorted(" ".join(s.split()[:3]).upper() for s in statements)
    # A heartbeat-only report stays three, with open commands and the pause.
    assert count() == ["BEGIN IMMEDIATE", "SELECT BOT_STATUS.ID AS", "UPDATE BOT_STATUS SET"]
    # BEGIN, bot_status, the commands named, their one UPDATE (executemany), the write of bot_status.
    more = ["BEGIN IMMEDIATE", "SELECT BOT_COMMANDS.COMMAND_ID, BOT_COMMANDS.KIND,", "SELECT BOT_STATUS.ID AS",
            "UPDATE BOT_COMMANDS SET", "UPDATE BOT_STATUS SET"]
    assert count(*(outcome(cid, "running") for cid in made)) == more
    assert count(*(outcome(cid, "done", output="x" * 100) for cid in made), hb=False) == more
    assert {row(cid)["state"] for cid in made} == {"done"}
    assert count(*(outcome(cid, "failed") for cid in made)) == [s for s in more if not s.startswith("UPDATE BOT_C")]  # all finished


def test_the_status_costs_the_same_statements_whatever_is_stored(client, online, team, it, make_user):
    def count():
        with sql() as statements:
            status(client, it)
        return len(statements)
    empty = count()
    people = [ready(make_user, 6000 + i) for i in range(5)]
    emit([p.user_id for p in people])
    crowd(250, 6100)
    send(client, team["chair"])
    for i in range(30):
        seed("logs", "done", ago(minutes=i))
    beat(client, updates=UPDATES)
    assert count() == empty
    pause(client, it).raise_for_status()
    paused = count()
    assert paused - empty <= 3  # the author with their avatar
    pause(client, it, False).raise_for_status()
    assert count() == empty


def test_creating_a_command_is_a_few_short_statements(client, online, it):
    linked(it.user_id, 7001)
    for i in range(300):
        seed(("logs", "restart")[i % 2], "done", ago(minutes=5 + i))

    def count(kind, args=None, key=None):
        """The route's own statements: those from its first read of a bot table on (the
        session and the rights before it are every route's)."""
        with sql() as statements:
            make(client, it, kind, args, key)
        statements = [" ".join(s.split()) for s in statements]
        start = next(i for i, s in enumerate(statements) if " FROM bot_" in s)
        return len(statements), [" ".join(s.split()[:2]) + " " + s.split(" FROM ")[-1].split()[0] if " FROM " in s
                                 else " ".join(s.split()[:3]) for s in statements[start:]]
    key = str(uuid.uuid4())
    total, own = count("update", {"version": "2.5.0"}, key)
    # The key, the status row, the open slot and the last restart in one SELECT, the link, the
    # author with the avatar, the command and the audit.
    assert own == ["SELECT bot_commands.command_id bot_commands", "SELECT bot_status.id bot_status",
                   "SELECT EXISTS bot_commands", "SELECT bot_links.user_id bot_links", "SELECT users.user_id users",
                   "SELECT profile_metadata.user_id profile_metadata", "INSERT INTO bot_commands", "INSERT INTO audit_logs"], own
    _, again = count("update", {"version": "2.5.0"}, key)
    assert again == ["SELECT bot_commands.command_id bot_commands", "SELECT users.user_id users",
                     "SELECT profile_metadata.user_id profile_metadata"], again  # a repeat reads the command back
    # The same for every kind without a key, whatever the history.
    assert count("restart") == count("logs") == (total - 1, own[1:])
    with db._session() as s:
        s.query(BotCommandORM).delete()
        s.commit()
    assert count("restart") == (total - 1, own[1:])
