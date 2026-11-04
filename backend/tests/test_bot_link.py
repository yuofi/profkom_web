"""HereBot stage 2: the VK link (backend/docs/BOT_API.md, «Привязка VK»).

Settings; link codes (format, normalization, hash, expiry, replacement, rate limit); the bot's
confirmation (idempotent repeat, every error, the failure limiter, relink, an archived
account's VK, VK ID identities); report events (at order, unknown VKs, one SELECT per report,
writes of changed rows only); the state precedence; registration readiness and exactly one
notice per transition; approve/resubmit refusals; the working-access gate after the deadline
with its open routes; /api/session and /api/bot-link/me; retention; the additive column on an
old schema; and that the gate and the session add no SQL.
"""
import hashlib
import json
import re
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

import auth
import bot_api
import bot_link
from bot_models import BotLinkCodeORM, BotLinkORM
from database import AuditLogORM, NotificationORM, UserORM, db
from errors import Forbidden
from settings import Settings, settings
from test_bot_api import BOT, HASH, at, body, sql
from test_retention_release_criteria import archive
from test_v13_access_contract import REGISTER

CODE, ME, CONFIRM, REPORT = "/api/bot-link/code", "/api/bot-link/me", "/api/bot/v1/links/confirm", "/api/bot/v1/report"
SHOWN = re.compile(r"^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)


@pytest.fixture(autouse=True)
def limits():
    bot_api.reset_limits()
    yield
    bot_api.reset_limits()


def err(response):
    return response.json()["detail"]["code"]


def issue(client, actor):
    r = client.post(CODE, headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()


def confirm(client, code, vk, messages=True, token="ok", when=None, **kw):
    return client.post(CONFIRM, headers=BOT, json={"api": 1, "code": code, "vk_user_id": vk, "messages_allowed": messages,
                                                   "token_status": token, "at": when or at(), **kw})


def link(client, actor, vk, **kw):
    r = confirm(client, issue(client, actor)["code"], vk, **kw)
    assert r.status_code == 200, r.text
    return r.json()


def report(client, vk_events=(), tokens=(), **kw):
    r = client.post(REPORT, headers=BOT, json=body(hb=None, vk_events=list(vk_events), tokens=list(tokens), **kw))
    assert r.status_code == 200, r.text
    return r.json()


def ev(vk, event, when):
    return {"vk_user_id": vk, "event": event, "at": when}


def tk(vk, status, when):
    return {"vk_user_id": vk, "status": status, "at": when}


def row(uid):
    with db._session() as s:
        link_ = s.get(BotLinkORM, uid)
        return None if link_ is None else {c.name: getattr(link_, c.name) for c in BotLinkORM.__table__.columns}


def codes():
    with db._session() as s:
        return [{c.name: getattr(r, c.name) for c in BotLinkCodeORM.__table__.columns} for r in s.query(BotLinkCodeORM)]


def state(uid):
    return db.get_user(uid).bot_link_state


def audits(uid):
    with db._session() as s:
        return [(json.loads(a.old_values_json), json.loads(a.new_values_json), a.changed_by_user_id)
                for a in s.query(AuditLogORM).filter_by(target_kind="user", target_id=str(uid), reason="bot_link").order_by(AuditLogORM.id)]


def notices(reviewer):
    with db._session() as s:
        return s.query(NotificationORM).filter_by(user_id=reviewer.user_id, kind="registration_submitted").count()


def register(client, email):
    r = client.post("/api/auth/register", json={**REGISTER, "email": email})
    assert r.status_code == 201, r.text
    headers = {"Authorization": "Bearer " + r.json()["access_token"]}
    return SimpleNamespace(user_id=client.get("/api/session", headers=headers).json()["user_id"], headers=headers)


def application(client, actor):
    r = client.get("/api/registrations/me", headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()


def queue_item(client, reviewer, uid):
    r = client.get("/api/registrations", headers=reviewer.headers)
    assert r.status_code == 200, r.text
    return next(i for i in r.json()["items"] if i["user_id"] == uid)


def decide(client, reviewer, uid, command="approve", reason=None):
    revision = queue_item(client, reviewer, uid)["revision"]
    return client.post(f"/api/registrations/{uid}/{command}", headers=reviewer.headers,
                       json={"expected_revision": revision, "reason": reason})


def deadline(monkeypatch, minutes):
    monkeypatch.setattr(settings, "BOT_LINK_DEADLINE", datetime.now(timezone.utc) + timedelta(minutes=minutes))


# ───────────────────────────── settings ─────────────────────────────

@pytest.mark.parametrize("value", ["", "https://vk.me/herebot", "https://vk.me/club123456", "https://vk.me/here_bot.vmk"])
def test_bot_vk_url_takes_a_vk_me_dialog(value):
    assert Settings(BOT_VK_URL=value).BOT_VK_URL == value


@pytest.mark.parametrize("value", ["https://vk.me/herebot?ref=1", "https://vk.me/herebot#x", "http://vk.me/herebot",
                                   "https://vk.com/herebot", "https://vk.me/", "https://vk.me/a/b", "vk.me/herebot"])
def test_bot_vk_url_refuses_anything_else(value):
    with pytest.raises(ValidationError):
        Settings(BOT_VK_URL=value)


def test_bot_link_deadline_needs_iso_8601_with_an_offset():
    assert Settings(BOT_LINK_DEADLINE="").BOT_LINK_DEADLINE is None
    assert Settings().BOT_LINK_DEADLINE is None
    moment = Settings(BOT_LINK_DEADLINE="2026-12-01T00:00:00+03:00").BOT_LINK_DEADLINE
    assert moment == datetime(2026, 11, 30, 21, tzinfo=timezone.utc)
    assert Settings(BOT_LINK_DEADLINE="2026-12-01T00:00:00Z").BOT_LINK_DEADLINE.utcoffset() == timedelta(0)
    for value in ("2026-12-01T00:00:00", "2026-12-01", "01.12.2026", "1764536400", 1764536400, "soon"):
        with pytest.raises(ValidationError):
            Settings(BOT_LINK_DEADLINE=value)


def test_a_malformed_setting_stops_the_import(tmp_path):
    """The backend does not start: settings are read on import, before the app exists."""
    root = Path(__file__).resolve().parents[1]
    for name, value in (("BOT_LINK_DEADLINE", "2026-12-01T00:00:00"), ("BOT_VK_URL", "https://vk.com/x")):
        result = subprocess.run([sys.executable, "-c", "import settings"], cwd=root, capture_output=True, text=True,
                                env={"PATH": "/usr/bin:/bin", name: value, "DATABASE_PATH": str(tmp_path / "x.db")})
        assert result.returncode != 0 and name in result.stderr


# ───────────────────────────── the state ─────────────────────────────

@pytest.mark.parametrize("messages,token,expected", [
    (True, "ok", "ok"), (True, "unknown", "ok"), (True, "missing", "token_missing"), (True, "invalid", "token_invalid"),
    (False, "ok", "messages_denied"), (False, "missing", "messages_denied"), (False, "invalid", "messages_denied"),
])
def test_state_is_the_first_unmet_condition(messages, token, expected):
    assert bot_link.state_of(SimpleNamespace(messages_allowed=messages, token_status=token)) == expected
    assert bot_link.state_of(None) is None


# ───────────────────────────── codes ─────────────────────────────

def test_disabled_integration_has_no_link(client, make_user):
    user = make_user()
    with sql() as statements:
        me = client.get(ME, headers=user.headers)
    assert me.json() == {"enabled": False, "state": None, "vk_user_id": None, "messages_allowed": None, "token_status": None,
                         "linked_at": None, "required": False, "blocked": False, "deadline": None, "bot_url": None,
                         "code_expires_at": None}
    assert len(statements) == 1  # the account
    r = client.post(CODE, headers=user.headers)
    assert (r.status_code, err(r)) == (404, "bot_api_disabled")
    assert codes() == []


def test_a_code_is_ten_crockford_characters_stored_as_a_hash(client, enabled, make_user, monkeypatch):
    user = make_user()
    data = issue(client, user)
    assert set(data) == {"code", "expires_at", "link_url", "command"}
    assert SHOWN.fullmatch(data["code"]) and data["command"] == "привязать " + data["code"]
    assert data["link_url"] is None
    expires = datetime.strptime(data["expires_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    assert abs((expires - datetime.now(timezone.utc) - timedelta(minutes=15)).total_seconds()) < 5
    plain = data["code"].replace("-", "")
    [stored] = codes()
    assert stored["code_hash"] == hashlib.sha256(plain.encode()).hexdigest()
    assert (stored["user_id"], stored["expires_at"], stored["used_at"], stored["used_vk_user_id"]) == (
        user.user_id, data["expires_at"], None, None)
    assert plain not in json.dumps(stored) and data["code"] not in json.dumps(stored)
    monkeypatch.setattr(settings, "BOT_VK_URL", "https://vk.me/club42")
    again = issue(client, user)
    assert again["link_url"] == "https://vk.me/club42?ref=" + again["code"].replace("-", "")
    assert len({issue(client, user)["code"] for _ in range(5)}) == 5


@pytest.mark.parametrize("typed,expected", [
    ("ABCDE-FGHJK", "ABCDEFGHJK"), (" abcde fghjk ", "ABCDEFGHJK"), ("abcde--fghjk", "ABCDEFGHJK"),
    ("O0OIL-1il10", "0001111110"), ("\tA1B2C3D4E5\n", "A1B2C3D4E5"),
])
def test_codes_are_read_as_the_bot_reads_them(typed, expected):
    assert bot_api.normalize(typed) == expected


@pytest.mark.parametrize("typed", ["", "ABCDE-FGHJ", "ABCDE-FGHJKM", "ABCDE-FGHJU", "ABCDE_FGHJK", "АБВГД-ЕЖЗИК"])
def test_what_is_not_a_code_is_no_code(typed):
    assert bot_api.normalize(typed) is None


def test_the_bot_may_send_the_code_as_the_person_typed_it(client, enabled, make_user):
    user = make_user()
    shown = issue(client, user)["code"]
    typed = " " + shown.lower().replace("0", "o").replace("1", "l").replace("-", " - ") + " "
    r = confirm(client, typed, 31337)
    assert r.status_code == 200, r.text


def test_a_new_code_replaces_the_accounts_others_and_drops_expired_ones(client, enabled, make_user):
    first, second = make_user(), make_user()
    old = issue(client, first)["code"]
    kept = issue(client, second)["code"]
    with db._session() as s:
        s.add(BotLinkCodeORM(code_hash="e" * 64, user_id=second.user_id, created_at=at(-30), expires_at=at(-15)))
        s.commit()
    new = issue(client, first)["code"]
    assert sorted(c["user_id"] for c in codes()) == sorted([first.user_id, second.user_id])
    assert "e" * 64 not in {c["code_hash"] for c in codes()}
    assert (confirm(client, old, 1).status_code, confirm(client, new, 1).status_code, confirm(client, kept, 2).status_code) == (404, 200, 200)


def test_at_most_ten_codes_an_hour_per_account(client, enabled, make_user, monkeypatch):
    user, other = make_user(), make_user()
    for _ in range(10):
        issue(client, user)
    r = client.post(CODE, headers=user.headers)
    assert (r.status_code, err(r)) == (429, "link_code_rate_limited")
    issue(client, other)
    later = datetime.now(timezone.utc) + timedelta(minutes=61)
    monkeypatch.setattr(bot_api, "utcnow", lambda: later)
    issue(client, user)


def test_code_routes_are_open_to_pending_closed_to_archived_and_banned(client, enabled, make_user, superuser):
    pending = register(client, "pending-link@example.com")
    assert client.get(ME, headers=pending.headers).json()["required"] is True
    issue(client, pending)
    banned, archived = make_user(banned=True), make_user()
    client.post(f"/api/accounts/{archived.user_id}/archive", headers=superuser.headers, json={"reason": "Выпуск"}).raise_for_status()
    for actor in (banned, archived):
        assert client.get(ME, headers=actor.headers).status_code in (401, 403)
        assert client.post(CODE, headers=actor.headers).status_code in (401, 403)
    assert client.get(ME).status_code == 401 and client.post(CODE).status_code == 401


# ───────────────────────────── the bot's confirmation ─────────────────────────────

def test_confirmation_links_the_account(client, enabled, make_user):
    user = make_user(name="Иван", surname="Петров")
    data = issue(client, user)
    when = at(-1)
    r = confirm(client, data["code"], 123456, token="missing", when=when)
    assert r.status_code == 200, r.text
    assert r.json() == {"api": 1, "linked": True, "user_id": user.user_id, "display_name": "Иван Петров", "state": "token_missing"}
    link_ = row(user.user_id)
    assert (link_["vk_user_id"], link_["messages_allowed"], link_["messages_at"], link_["token_status"], link_["token_at"]) == (
        123456, True, when, "missing", when)
    assert link_["linked_at"] == link_["updated_at"] >= at(-0.2)
    assert state(user.user_id) == "token_missing"
    [used] = codes()
    assert used["used_vk_user_id"] == 123456 and used["used_at"] == link_["linked_at"]
    assert audits(user.user_id) == [({"vk_user_id": None}, {"vk_user_id": 123456}, user.user_id)]
    me = client.get(ME, headers=user.headers).json()
    assert me == {"enabled": True, "state": "token_missing", "vk_user_id": 123456, "messages_allowed": True,
                  "token_status": "missing", "linked_at": link_["linked_at"], "required": False, "blocked": False,
                  "deadline": None, "bot_url": None, "code_expires_at": None}


def test_a_repeat_with_the_same_code_and_vk_answers_the_same_and_changes_nothing(client, enabled, make_user):
    user = make_user()
    shown = issue(client, user)["code"]
    first = confirm(client, shown, 77)
    before = (row(user.user_id), codes(), audits(user.user_id))
    with sql() as statements:
        again = confirm(client, shown, 77, messages=False, token="invalid")
    assert again.status_code == 200 and again.json() == first.json()
    assert (row(user.user_id), codes(), audits(user.user_id)) == before
    assert not [s for s in statements if s.split()[0].upper() in ("INSERT", "UPDATE", "DELETE")]
    # Another VK with a used code, or the same VK after the code expired: 404.
    assert err(confirm(client, shown, 78)) == "link_code_invalid"
    with db._session() as s:
        s.query(BotLinkCodeORM).update({"expires_at": at(-1)})
        s.commit()
    assert err(confirm(client, shown, 77)) == "link_code_invalid"


def test_confirmation_errors(client, enabled, make_user, superuser, monkeypatch):
    user = make_user()
    shown = issue(client, user)["code"]
    for code in ("AAAAA-AAAAA", "not a code", "ABCDE-FGHJU"):
        r = confirm(client, code, 1)
        assert (r.status_code, err(r)) == (404, "link_code_invalid"), r.text
        assert set(r.json()["detail"]) == {"code", "message", "fields"}
    with db._session() as s:
        s.query(BotLinkCodeORM).update({"expires_at": at()})
        s.commit()
    assert err(confirm(client, shown, 1)) == "link_code_invalid"  # expires at this second
    banned = make_user()
    banned_code = issue(client, banned)["code"]
    db.update_user(banned.user_id, banned=True)
    assert err(confirm(client, banned_code, 2)) == "link_code_invalid"
    leaving = make_user()
    leaving_code = issue(client, leaving)["code"]
    client.post(f"/api/accounts/{leaving.user_id}/archive", headers=superuser.headers, json={"reason": "Выпуск"}).raise_for_status()
    assert err(confirm(client, leaving_code, 3)) == "link_code_invalid"
    assert row(banned.user_id) is None and row(leaving.user_id) is None
    good = issue(client, user)["code"]
    for change in ({"vk_user_id": 0}, {"vk_user_id": -5}, {"token_status": "fresh"}, {"at": None}, {"api": 2},
                   {"code": ""}, {"messages_allowed": "maybe"}):
        r = client.post(CONFIRM, headers=BOT, json={"api": 1, "code": good, "vk_user_id": 5, "messages_allowed": True,
                                                    "token_status": "ok", "at": at(), **change})
        assert (r.status_code, err(r)) == (422, "validation_error"), change
    assert confirm(client, good, 5, future_field=1).status_code == 200
    assert client.post(CONFIRM, json={}).status_code == 401
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", "")
    assert err(confirm(client, good, 5)) == "bot_api_disabled"


def test_an_account_of_a_vk_id_login_links_only_that_vk(client, enabled, make_user):
    user = make_user()
    db.link_external_identity(user.user_id, "vk:555")
    shown = issue(client, user)["code"]
    r = confirm(client, shown, 556)
    assert (r.status_code, err(r)) == (409, "vk_mismatch")
    assert row(user.user_id) is None and codes()[0]["used_at"] is None
    assert confirm(client, shown, 555).json()["user_id"] == user.user_id


def test_a_vk_of_another_account_is_taken(client, enabled, make_user, superuser):
    owner, other, login = make_user(), make_user(), make_user()
    link(client, owner, 100)
    r = confirm(client, issue(client, other)["code"], 100)
    assert (r.status_code, err(r)) == (409, "vk_taken")
    db.update_user(owner.user_id, banned=True)  # banned is not archived: still taken
    assert err(confirm(client, issue(client, other)["code"], 100)) == "vk_taken"
    db.link_external_identity(login.user_id, "vk:300")  # the VK ID login of another account
    client.post(f"/api/accounts/{login.user_id}/archive", headers=superuser.headers, json={"reason": "Выпуск"}).raise_for_status()
    assert err(confirm(client, issue(client, other)["code"], 300)) == "vk_taken"
    assert row(other.user_id) is None and state(other.user_id) is None
    # A vk_mismatch comes before vk_taken.
    db.link_external_identity(other.user_id, "vk:301")
    assert err(confirm(client, issue(client, other)["code"], 100)) == "vk_mismatch"


def test_an_archived_account_gives_its_vk_up_and_keeps_it_until_then(client, enabled, make_user, superuser):
    old, new = make_user(), make_user()
    link(client, old, 100)
    client.post(f"/api/accounts/{old.user_id}/archive", headers=superuser.headers, json={"reason": "Выпуск"}).raise_for_status()
    assert row(old.user_id)["vk_user_id"] == 100 and state(old.user_id) == "ok"  # archive keeps the link
    assert link(client, new, 100)["user_id"] == new.user_id
    assert row(old.user_id) is None and state(old.user_id) is None and row(new.user_id)["vk_user_id"] == 100
    assert audits(old.user_id)[-1] == ({"vk_user_id": 100}, {"vk_user_id": None}, new.user_id)
    assert audits(new.user_id) == [({"vk_user_id": None}, {"vk_user_id": 100}, new.user_id)]


def test_a_new_vk_replaces_the_old_one(client, enabled, make_user):
    user, other = make_user(), make_user()
    link(client, user, 100, when=at(-5))
    first = row(user.user_id)
    report(client, vk_events=[ev(100, "message_deny", at(-4))])
    assert link(client, user, 101, token="unknown")["state"] == "ok"
    second = row(user.user_id)
    assert (second["vk_user_id"], second["messages_allowed"], second["token_status"]) == (101, True, "unknown")
    assert second["linked_at"] >= first["linked_at"] and second["messages_at"] > first["messages_at"]
    assert audits(user.user_id)[-1] == ({"vk_user_id": 100}, {"vk_user_id": 101}, user.user_id)
    assert link(client, other, 100)["user_id"] == other.user_id  # the old VK is free


def test_messages_allowed_null_keeps_the_known_value_and_means_allowed_for_a_new_link(client, enabled, make_user):
    user = make_user()
    assert link(client, user, 100, messages=None, when=at(-5))["state"] == "ok"
    assert row(user.user_id)["messages_allowed"] is True
    report(client, vk_events=[ev(100, "message_deny", at(-4))])
    again = link(client, user, 100, messages=None, token="ok", when=at(-3))
    assert again["state"] == "messages_denied" and row(user.user_id)["messages_at"] == at(-4)
    # The same VK again: a confirmation older than the stored values does not win.
    assert link(client, user, 100, messages=True, token="missing", when=at(-6))["state"] == "messages_denied"
    assert row(user.user_id)["token_status"] == "ok"
    assert link(client, user, 100, messages=True, token="ok", when=at(-1))["state"] == "ok"


def test_failed_confirmations_are_limited_per_vk_and_in_all(client, enabled, make_user, monkeypatch):
    user = make_user()
    for _ in range(10):
        assert err(confirm(client, "AAAAA-AAAAA", 900)) == "link_code_invalid"
    shown = issue(client, user)["code"]
    r = confirm(client, shown, 900)
    assert (r.status_code, err(r)) == (429, "link_rate_limited")
    assert err(confirm(client, shown, 900)) == "link_rate_limited"  # a refusal is not counted again
    assert codes()[0]["used_at"] is None
    # Conflicts count too; another VK is not limited by these.
    other = make_user()
    link(client, other, 901)
    assert err(confirm(client, issue(client, make_user())["code"], 901)) == "vk_taken"
    now = datetime.now(timezone.utc)
    assert (bot_api.FAILURES.count(900, now), bot_api.FAILURES.count(901, now), bot_api.FAILURES.count(None, now)) == (10, 1, 11)
    # Fifteen minutes later VK 900 tries again.
    later = now + timedelta(minutes=16)
    monkeypatch.setattr(bot_api, "utcnow", lambda: later)
    assert confirm(client, issue(client, user)["code"], 900).status_code == 200
    monkeypatch.undo()
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    # Over 200 failures of everyone close the confirmation for every VK.
    bot_api.reset_limits()
    for _ in range(199):
        bot_api.FAILURES.add(None, datetime.now(timezone.utc))
    late = make_user()
    shown = issue(client, late)["code"]
    assert err(confirm(client, "AAAAA-AAAAA", 902)) == "link_code_invalid"  # the 200th
    assert err(confirm(client, shown, 903)) == "link_rate_limited"
    bot_api.reset_limits()
    assert confirm(client, shown, 903).status_code == 200


# ───────────────────────────── events in the report ─────────────────────────────

def test_events_apply_to_a_linked_vk_in_the_order_of_their_time(client, enabled, make_user):
    user = make_user()
    link(client, user, 100, when=at(-10))
    report(client, vk_events=[ev(100, "message_deny", at(-9))])
    assert state(user.user_id) == "messages_denied" and row(user.user_id)["messages_at"] == at(-9)
    report(client, vk_events=[ev(100, "message_allow", at(-9.5))])  # older than the stored value
    assert state(user.user_id) == "messages_denied"
    report(client, vk_events=[ev(100, "message_allow", at(-8)), ev(100, "message_deny", at(-8))])  # the last of equal times
    assert state(user.user_id) == "messages_denied"
    report(client, vk_events=[ev(100, "message_deny", at(-7)), ev(100, "message_allow", at(-7))])
    assert state(user.user_id) == "ok"
    report(client, tokens=[tk(100, "missing", at(-6))])
    assert state(user.user_id) == "token_missing"
    report(client, tokens=[tk(100, "invalid", at(-6))])  # not before the stored time: applies
    assert state(user.user_id) == "token_invalid"
    report(client, tokens=[tk(100, "unknown", at(-5))])
    assert state(user.user_id) == "ok"
    report(client, vk_events=[ev(100, "message_deny", at(-4))], tokens=[tk(100, "missing", at(-4))])
    assert state(user.user_id) == "messages_denied"
    report(client, vk_events=[ev(100, "message_allow", at(-3))])
    assert state(user.user_id) == "token_missing"
    report(client, tokens=[tk(100, "ok", at(-2))], vk_events=[ev(100, "message_typing", at(-1))])
    stored = row(user.user_id)
    assert (state(user.user_id), stored["messages_at"], stored["token_status"], stored["token_at"]) == ("ok", at(-3), "ok", at(-2))
    report(client, tokens=[tk(100, "revoked", at())])  # an unknown status is skipped
    assert row(user.user_id)["token_status"] == "ok"


def test_unknown_vks_are_skipped_and_not_stored(client, enabled, make_user):
    user = make_user()
    link(client, user, 100)
    before = row(user.user_id)
    report(client, vk_events=[ev(4242, "message_deny", at())], tokens=[tk(4243, "invalid", at())])
    with db._session() as s:
        assert s.query(BotLinkORM).count() == 1
    assert row(user.user_id) == before


def test_a_repeated_report_applies_nothing(client, enabled, make_user):
    """Dedup by report_id comes first: a repeat of the last report changes nothing."""
    user = make_user()
    link(client, user, 100, when=at(-5))
    payload = body(hb=None, vk_events=[ev(100, "message_deny", at(-1))])
    assert client.post(REPORT, headers=BOT, json=payload).json()["duplicate"] is False
    before = row(user.user_id)
    payload["vk_events"] = [ev(100, "message_allow", at())]
    assert client.post(REPORT, headers=BOT, json=payload).json()["duplicate"] is True
    assert row(user.user_id) == before and state(user.user_id) == "messages_denied"


def test_at_most_500_events_and_tokens(client, enabled):
    for field, make in (("vk_events", lambda i: ev(i + 1, "message_allow", at())), ("tokens", lambda i: tk(i + 1, "ok", at()))):
        r = client.post(REPORT, headers=BOT, json=body(**{field: [make(i) for i in range(501)]}))
        assert (r.status_code, err(r)) == (422, "validation_error")
        assert client.post(REPORT, headers=BOT, json=body(**{field: [make(i) for i in range(500)]})).status_code == 200
    r = client.post(REPORT, headers=BOT, json=body(vk_events=[ev(0, "message_allow", at())]))
    assert r.status_code == 422


def _seed_links(make_user, count, first_vk=1000):
    people = [make_user(password=None) for _ in range(count)]
    with db._session() as s:
        for i, person in enumerate(people):
            bot_api.save_link(s, s.get(UserORM, person.user_id), BotLinkORM(
                user_id=person.user_id, vk_user_id=first_vk + i, messages_allowed=True, messages_at=at(-10),
                token_status="ok", token_at=at(-10), linked_at=at(-10), updated_at=at(-10)))
        s.commit()
    return people


def test_a_report_reads_the_links_once_and_writes_only_changed_rows(client, enabled, make_user):
    people = _seed_links(make_user, 50)
    events = [ev(1000 + i, "message_deny" if i % 2 else "message_allow", at(-1)) for i in range(50)]
    events += [ev(5000 + i, "message_deny", at(-1)) for i in range(20)]  # not linked
    with sql() as statements:
        report(client, vk_events=events, tokens=[tk(1000 + i, "ok", at(-10)) for i in range(50)])
    link_reads = [s for s in statements if s.lstrip().upper().startswith("SELECT") and "FROM bot_links" in s]
    assert len(link_reads) == 1 and "IN" in link_reads[0]
    assert {state(p.user_id) for p in people[1::2]} == {"messages_denied"} and {state(p.user_id) for p in people[::2]} == {"ok"}
    # The same facts again (a new report): nothing to write.
    with sql() as statements:
        report(client, vk_events=events, tokens=[tk(1000 + i, "ok", at(-10)) for i in range(50)])
    words = [s.split()[0].upper() for s in statements]
    assert words.count("UPDATE") == 1 and "INSERT" not in words, statements  # bot_status only
    assert not [s for s in statements if "FROM users" in s]


# ───────────────────────────── registration readiness ─────────────────────────────

def test_without_the_integration_registration_works_as_before(client, superuser):
    person = register(client, "before@example.com")
    assert notices(superuser) == 1
    mine = application(client, person)
    assert mine["bot_link"] is None
    assert "approve_registration" in queue_item(client, superuser, person.user_id)["capabilities"]
    assert decide(client, superuser, person.user_id).status_code == 200


def test_an_email_registration_reaches_the_reviewers_once_it_is_linked(client, enabled, superuser):
    person = register(client, "linked@example.com")
    assert notices(superuser) == 0
    assert application(client, person)["bot_link"] == {"state": "none", "vk_user_id": None}
    item = queue_item(client, superuser, person.user_id)
    assert "approve_registration" not in item["capabilities"] and "reject_registration" in item["capabilities"]
    r = decide(client, superuser, person.user_id)
    assert (r.status_code, err(r)) == (409, "bot_link_required")
    link(client, person, 700, token="missing", when=at(-5))
    assert notices(superuser) == 0  # complete, but the bot has no token
    report(client, tokens=[tk(700, "ok", at(-4))])
    assert notices(superuser) == 1
    item = queue_item(client, superuser, person.user_id)
    assert item["bot_link"] == {"state": "ok", "vk_user_id": 700} and "approve_registration" in item["capabilities"]
    report(client, tokens=[tk(700, "ok", at(-3))])  # no transition
    report(client, vk_events=[ev(700, "message_deny", at(-2))])
    item = queue_item(client, superuser, person.user_id)
    assert item["bot_link"]["state"] == "messages_denied" and "approve_registration" not in item["capabilities"]
    assert err(decide(client, superuser, person.user_id)) == "bot_link_required"
    report(client, vk_events=[ev(700, "message_allow", at(-1))])
    assert notices(superuser) == 1  # ready again within the same submission: one notice per submission
    r = decide(client, superuser, person.user_id)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert client.get("/api/session", headers=person.headers).json()["account_state"] == "active"


def test_a_confirmation_with_everything_working_notifies_at_once_exactly_once(client, enabled, superuser):
    person = register(client, "at-once@example.com")
    shown = issue(client, person)["code"]
    assert confirm(client, shown, 701).json()["state"] == "ok"
    assert notices(superuser) == 1
    confirm(client, shown, 701)  # the bot's repeat
    report(client, vk_events=[ev(701, "message_allow", at(1))])
    assert notices(superuser) == 1


def test_a_vk_application_is_ready_after_both_its_fields_and_its_link(client, enabled, superuser, mock_vk):
    from test_v13_registration import filled, vk_applicant

    h, a = vk_applicant(client, mock_vk, vk_id="6161")
    person = SimpleNamespace(user_id=a["user_id"], headers=h)
    link(client, person, 6161)
    assert state(person.user_id) == "ok" and notices(superuser) == 0  # fields missing
    r = client.patch("/api/registrations/me", headers=h, json={"expected_revision": a["revision"], "fields": filled(a)})
    assert r.status_code == 200, r.text
    assert notices(superuser) == 1 and r.json()["bot_link"] == {"state": "ok", "vk_user_id": 6161}
    client.patch("/api/registrations/me", headers=h, json={"expected_revision": r.json()["revision"],
                                                          "fields": filled(a, residence="Общежитие")}).raise_for_status()
    assert client.post("/api/auth/vk", json={"access_token": "vk-token"}).status_code == 200  # a new VK login
    assert notices(superuser) == 1


def test_a_vk_application_with_fields_first_waits_for_the_link(client, enabled, superuser, mock_vk):
    from test_v13_registration import filled, vk_applicant

    h, a = vk_applicant(client, mock_vk, vk_id="6262")
    client.patch("/api/registrations/me", headers=h, json={"expected_revision": a["revision"], "fields": filled(a)}).raise_for_status()
    assert notices(superuser) == 0
    assert client.post("/api/auth/vk", json={"access_token": "vk-token"}).status_code == 200
    assert notices(superuser) == 0
    link(client, SimpleNamespace(user_id=a["user_id"], headers=h), 6262)
    assert notices(superuser) == 1


def test_resubmission_needs_a_working_link(client, enabled, superuser):
    person = register(client, "again@example.com")
    link(client, person, 702, when=at(-5))
    assert decide(client, superuser, person.user_id, "reject", "Нет фото").status_code == 200
    report(client, vk_events=[ev(702, "message_deny", at(-4))])
    mine = application(client, person)
    r = client.post("/api/registrations/me/resubmit", headers=person.headers, json={"expected_revision": mine["revision"]})
    assert (r.status_code, err(r)) == (409, "bot_link_required")
    report(client, vk_events=[ev(702, "message_allow", at(-3))])
    assert notices(superuser) == 1  # a rejected application is not announced by the link
    r = client.post("/api/registrations/me/resubmit", headers=person.headers, json={"expected_revision": mine["revision"]})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending" and notices(superuser) == 2


def test_the_reviewers_queue_reads_the_links_in_one_query(client, enabled, superuser):
    people = [register(client, f"queue{i}@example.com") for i in range(4)]
    link(client, people[0], 801)
    link(client, people[2], 803, messages=False)
    with sql() as statements:
        r = client.get("/api/registrations", headers=superuser.headers)
    assert len([s for s in statements if "FROM bot_links" in s]) == 1
    items = {i["user_id"]: i["bot_link"] for i in r.json()["items"]}
    assert [items[p.user_id] for p in people] == [{"state": "ok", "vk_user_id": 801}, {"state": "none", "vk_user_id": None},
                                                  {"state": "messages_denied", "vk_user_id": 803}, {"state": "none", "vk_user_id": None}]


# ───────────────────────────── the gate and the session ─────────────────────────────

def session_link(client, actor):
    r = client.get("/api/session", headers=actor.headers)
    assert r.status_code == 200, r.text
    return r.json()["bot_link"]


def test_session_bot_link(client, enabled, make_user, monkeypatch):
    user = make_user()
    pending = register(client, "session@example.com")
    assert session_link(client, pending) == {"state": "none", "required": True, "blocked": False, "deadline": None}
    assert session_link(client, user) == {"state": "none", "required": False, "blocked": False, "deadline": None}
    monkeypatch.setattr(settings, "BOT_LINK_DEADLINE", datetime(2026, 12, 1, tzinfo=timezone(timedelta(hours=3))))
    later = datetime.now(timezone.utc) < datetime(2026, 11, 30, 21, tzinfo=timezone.utc)
    assert session_link(client, user) == {"state": "none", "required": not later, "blocked": not later,
                                          "deadline": "2026-11-30T21:00:00Z"}
    deadline(monkeypatch, -1)
    assert session_link(client, user)["blocked"] is True
    link(client, user, 100)
    assert session_link(client, user) == {"state": "ok", "required": True, "blocked": False,
                                          "deadline": bot_api.stamp(settings.BOT_LINK_DEADLINE)}
    db.update_user(user.user_id, must_change_password=True)
    data = client.get("/api/session", headers=user.headers).json()
    assert data["password_change_required"] is True and data["bot_link"]["state"] == "ok"
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", "")
    assert session_link(client, user) is None and session_link(client, pending) is None


def test_after_the_deadline_an_active_account_works_only_when_linked(client, enabled, make_user, monkeypatch):
    user = make_user()
    assert client.get("/api/blocks", headers=user.headers).status_code == 200
    deadline(monkeypatch, 60)  # before the deadline: only the banner
    assert client.get("/api/blocks", headers=user.headers).status_code == 200
    deadline(monkeypatch, -1)
    r = client.get("/api/blocks", headers=user.headers)
    assert (r.status_code, err(r)) == (403, "bot_link_required")
    assert set(r.json()["detail"]) == {"code", "message", "fields"}
    legacy = client.get("/api/contacts", headers=user.headers)  # an old route keeps a plain detail
    assert legacy.status_code == 403 and legacy.json() == {"detail": auth.BOT_LINK_REQUIRED}
    # Still open: the session, registration, the link routes, the bot console (its own rights), auth.
    assert client.get("/api/session", headers=user.headers).json()["bot_link"]["blocked"] is True
    assert client.get("/api/registrations/me", headers=user.headers).status_code == 200
    assert client.get(ME, headers=user.headers).json()["blocked"] is True
    console = client.get("/api/bot/console/status", headers=user.headers)
    assert console.status_code == 403 and err(console) != "bot_link_required"
    shown = issue(client, user)["code"]
    pw = client.post("/api/auth/change-password", headers=user.headers,
                     json={"old_password": user.password, "new_password": "Another-Passw0rd!"})
    assert pw.status_code == 200, pw.text
    user.access_token = client.post("/api/auth/login", json={"email": user.email, "password": "Another-Passw0rd!"}).json()["access_token"]
    feedback = client.post("/api/feedback", headers=user.headers, json={
        "kind": "bug", "title": "Не открывается", "body": "Сайт просит бота", "idempotency_key": str(__import__("uuid").uuid4())})
    assert feedback.status_code in (200, 201), feedback.text
    # A link with a working token opens the site; denied messages close it again; a token VK
    # did not answer about does not.
    confirm(client, shown, 100, token="unknown", when=at(-5)).raise_for_status()
    assert client.get("/api/blocks", headers=user.headers).status_code == 200
    report(client, vk_events=[ev(100, "message_deny", at(-4))])
    assert err(client.get("/api/blocks", headers=user.headers)) == "bot_link_required"
    report(client, vk_events=[ev(100, "message_allow", at(-3))], tokens=[tk(100, "invalid", at(-3))])
    assert err(client.get("/api/blocks", headers=user.headers)) == "bot_link_required"
    report(client, tokens=[tk(100, "ok", at(-2))])
    assert client.get("/api/blocks", headers=user.headers).status_code == 200


def test_no_gate_without_the_integration_or_the_deadline(client, make_user, monkeypatch):
    user = make_user()
    deadline(monkeypatch, -1)
    assert client.get("/api/blocks", headers=user.headers).status_code == 200  # integration off
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    monkeypatch.setattr(settings, "BOT_LINK_DEADLINE", None)
    assert client.get("/api/blocks", headers=user.headers).status_code == 200


def test_the_temporary_password_is_changed_before_the_link(client, enabled, make_user, monkeypatch):
    user = make_user()
    deadline(monkeypatch, -1)
    db.update_user(user.user_id, must_change_password=True)
    r = client.get("/api/blocks", headers=user.headers)
    assert r.status_code == 403 and r.json()["detail"]["message"] == auth.PASSWORD_CHANGE_REQUIRED


def test_a_pending_account_is_not_held_by_the_deadline(client, enabled, monkeypatch):
    pending = register(client, "pending-gate@example.com")
    deadline(monkeypatch, -1)
    assert client.get("/api/session", headers=pending.headers).json()["bot_link"]["blocked"] is False
    r = client.get("/api/blocks", headers=pending.headers)
    assert r.status_code == 403 and r.json()["detail"]["message"] == "Approved active account required"
    issue(client, pending)
    assert client.get(ME, headers=pending.headers).status_code == 200


def test_the_own_transaction_recheck_applies_the_same_rule(client, enabled, make_user, monkeypatch):
    user = make_user()
    current = db.get_user(user.user_id)
    with db.atomic():
        assert auth.recheck_current_user(current, working=True).user_id == user.user_id
    deadline(monkeypatch, -1)
    with db.atomic():
        assert auth.recheck_current_user(current).user_id == user.user_id  # not a working route
        with pytest.raises(Forbidden) as refused:
            auth.recheck_current_user(current, working=True)
    assert refused.value.code == "bot_link_required"
    link(client, user, 100)
    with db.atomic():
        assert auth.recheck_current_user(current, working=True).bot_link_state == "ok"


def _statements(client, actor, path):
    client.get(path, headers=actor.headers).raise_for_status()  # warm
    with sql() as statements:
        client.get(path, headers=actor.headers).raise_for_status()
    return len(statements)


def test_the_gate_and_the_session_add_no_sql(client, make_user, superuser, monkeypatch):
    linked, unlinked = make_user(), make_user()
    paths = ("/api/session", "/api/blocks", "/api/workspace/home")
    off = {who.user_id: [_statements(client, who, p) for p in paths] for who in (linked, unlinked, superuser)}
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", HASH)
    link(client, linked, 100)
    deadline(monkeypatch, 60)
    on = {who.user_id: [_statements(client, who, p) for p in paths] for who in (linked, unlinked, superuser)}
    assert on == off
    deadline(monkeypatch, -1)
    assert [_statements(client, linked, p) for p in paths] == off[linked.user_id]
    assert _statements(client, unlinked, "/api/session") == off[unlinked.user_id][0]


def test_link_status_reads_at_most_two_statements(client, enabled, make_user):
    user = make_user()
    link(client, user, 100)
    code = issue(client, user)
    with sql() as statements:
        me = client.get(ME, headers=user.headers).json()
    assert len(statements) <= 2, statements
    assert me["code_expires_at"] == code["expires_at"] and me["vk_user_id"] == 100
    with sql() as statements:
        issue(client, user)
    assert len(statements) <= 4, statements  # BEGIN, the account, DELETE, INSERT


# ───────────────────────────── retention and the old schema ─────────────────────────────

def test_retention_removes_the_link_and_the_codes(client, enabled, make_user, superuser):
    from account_cleanup import purge

    person, other = make_user(), make_user()
    link(client, person, 100)
    issue(client, person)
    link(client, other, 101)
    archive(client, superuser, person)
    assert row(person.user_id) is not None  # the archive keeps it
    assert purge("2024-01-01T00:00:00+00:00", False)["purged_count"] == 1
    assert row(person.user_id) is None and state(person.user_id) is None
    assert [c for c in codes() if c["user_id"] == person.user_id] == []
    assert row(other.user_id)["vk_user_id"] == 101 and state(other.user_id) == "ok"
    assert [new for _, new, _ in audits(person.user_id)] == [{"vk_user_id": None}]  # the VK is gone from its audit
    assert link(client, make_user(), 100)["state"] == "ok"  # the VK is free


def test_an_old_users_table_gains_bot_link_state_twice(tmp_path):
    path = tmp_path / "old-users.db"
    root = Path(__file__).resolve().parents[1]
    env = {**__import__("os").environ, "DATABASE_PATH": str(path)}
    subprocess.run([sys.executable, "-c", "import database"], cwd=root, env=env, check=True, capture_output=True)
    with sqlite3.connect(path) as c:
        c.execute("ALTER TABLE users DROP COLUMN bot_link_state")
        c.execute("INSERT INTO users (user_id, hashed_password, kkr_score, group_number, blocks, banned, super_user, admin) "
                  "VALUES (7, '', 3, '101', '', 0, 0, 0)")
    script = ("import json, database; from sqlalchemy import text; c = database.engine.connect(); "
              "cols = [r[1] for r in c.execute(text('PRAGMA table_info(users)'))]; c.close(); "
              "u = database.db.get_user(7); print(json.dumps([cols.count('bot_link_state'), u.bot_link_state, u.kkr_score]))")
    for _ in range(2):
        result = subprocess.run([sys.executable, "-c", script], cwd=root, env=env, check=True, capture_output=True, text=True)
        assert json.loads(result.stdout.strip().splitlines()[-1]) == [1, None, 3]
    with sqlite3.connect(path) as c:
        assert c.execute("PRAGMA quick_check").fetchone()[0] == "ok"
