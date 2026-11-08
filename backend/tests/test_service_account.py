"""The service (root) account (owner, 2026-11-08; backend/docs/SERVICE_ACCOUNT.md).

Settings and the startup step; sign-in through the ordinary form (success, failure, feature
off, removed or rotated configuration, the per-client limit); full rights and the chair's own
actions; absence from every list of people; refusal as an assignee, member, role holder or
recipient; the display name; no VK link, banner, gate or VK notification; the site-only
notices of a sign-in and of three failed ones in a row; the hash helper.
"""
import io
import json
import re
import uuid
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy.exc import IntegrityError

import auth
import database
import service_account
from database import BlockORM, ContactInfoORM, NotificationORM, RefreshTokenORM, UserORM, db
from profile_features_models import NotificationDeliveryEventORM
from service_account_models import ServiceLoginStateORM, ServiceLoginThrottleORM
from settings import Settings, settings
from test_proxy_client_ip import from_peer

LOGIN, PASSWORD = "root", "Synthetic-Service-Pass-1"
HASH = auth.hash_password(PASSWORD)
AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
         "Chrome/130.0.0.0 Safari/537.36")
NAME = "Сервисный аккаунт"


def rich(body):
    return {"format": "markdown", "body": body}


def stamp(days=0.0):
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "ROOT_LOGIN", LOGIN)
    monkeypatch.setattr(settings, "ROOT_PASSWORD_HASH", HASH)


def sign_in(client, password=PASSWORD, login=LOGIN, agent=AGENT):
    return client.post("/api/auth/login", json={"email": login, "password": password}, headers={"User-Agent": agent})


def service(client):
    """Signs the service account in: its row id and the bearer headers."""
    r = sign_in(client)
    assert r.status_code == 200, r.text
    return service_id(), {"Authorization": f"Bearer {r.json()['access_token']}"}


def service_id():
    with db._session() as s:
        return s.query(UserORM.user_id).filter(UserORM.is_service.is_(True)).scalar()


def notices(uid, kind=None):
    with db._session() as s:
        q = s.query(NotificationORM).filter_by(user_id=uid)
        if kind:
            q = q.filter_by(kind=kind)
        return [(n.kind, json.loads(n.payload_json)) for n in q.order_by(NotificationORM.created_at)]


# ───────────────────────────── settings and the startup step ─────────────────────────────

def test_settings_take_a_login_and_a_bcrypt_hash_and_never_repeat_a_refused_value():
    assert Settings(ROOT_LOGIN="root", ROOT_PASSWORD_HASH=f" {HASH}\n").ROOT_PASSWORD_HASH == HASH
    for fields in ({"ROOT_LOGIN": "ro ot"}, {"ROOT_LOGIN": "root@site"}, {"ROOT_LOGIN": "r" * 65},
                   {"ROOT_PASSWORD_HASH": "plain-password-by-mistake"}, {"ROOT_PASSWORD_HASH": HASH[:-1]}):
        with pytest.raises(ValidationError) as caught:
            Settings(**fields)
        assert next(iter(fields.values())) not in str(caught.value)


def test_off_without_either_setting(client, monkeypatch, make_user):
    for login, hashed in (("", ""), (LOGIN, ""), ("", HASH)):
        monkeypatch.setattr(settings, "ROOT_LOGIN", login)
        monkeypatch.setattr(settings, "ROOT_PASSWORD_HASH", hashed)
        service_account.sync()
        assert not service_account.enabled() and service_id() is None
        # No different answer from any other non-address: the setting is not revealed.
        assert sign_in(client).status_code == 422
    assert service_id() is None


def test_the_startup_step_makes_one_row_idempotently_and_resets_any_legacy_flag(client, configured):
    service_account.sync()
    service_account.sync()
    with db._session() as s:
        rows = s.query(UserORM).filter(UserORM.is_service.is_(True)).all()
        assert len(rows) == 1
        row = rows[0]
        assert row.hashed_password == HASH and row.account_state == "active"
        contact = s.get(ContactInfoORM, row.user_id)
        assert (contact.name, contact.kkr_name, contact.email) == (NAME, NAME, service_account.EMAIL)
        row.super_user = row.admin = row.banned = row.must_change_password = True
        row.account_state, row.blocks = "archived", "IT"
        s.commit()
    service_account.sync()
    with db._session() as s:
        row = s.query(UserORM).filter(UserORM.is_service.is_(True)).one()
        assert not (row.super_user or row.admin or row.banned or row.must_change_password)
        assert (row.account_state, row.blocks) == ("active", "")


def test_only_the_startup_step_marks_the_account(client, configured, make_user):
    person = make_user()
    from errors import InvalidInput
    with pytest.raises(InvalidInput):
        db.update_user(person.user_id, is_service=True)
    assert not db.get_user(person.user_id).is_service
    service_account.sync()
    with db._session() as s, pytest.raises(IntegrityError):
        s.query(UserORM).filter_by(user_id=person.user_id).update({"is_service": True})
        s.flush()  # the partial unique index: one service row at most


def test_the_schema_upgrade_is_idempotent():
    database._ensure_sqlite_users_is_service_column()
    database._ensure_sqlite_users_is_service_column()
    with database.engine.connect() as c:
        columns = [r[1] for r in c.exec_driver_sql("PRAGMA table_info(users)")]
        indexes = [r[1] for r in c.exec_driver_sql("PRAGMA index_list(users)")]
    assert columns.count("is_service") == 1 and "ux_users_service" in indexes


def test_the_notice_key_upgrade_is_idempotent_and_keeps_the_count(tmp_path):
    from sqlalchemy import create_engine
    import service_account_models
    old = create_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with old.begin() as c:
        c.exec_driver_sql("CREATE TABLE service_login_state (state_id INTEGER PRIMARY KEY, "
                          "failures INTEGER NOT NULL DEFAULT 0, last_failed_at VARCHAR)")
        c.exec_driver_sql("INSERT INTO service_login_state VALUES (1, 4, '2026-11-08T00:00:00+00:00')")
    service_account_models.upgrade(old)
    service_account_models.upgrade(old)
    with old.connect() as c:
        columns = [r[1] for r in c.exec_driver_sql("PRAGMA table_info(service_login_state)")]
        row = tuple(c.exec_driver_sql("SELECT failures, notice_key FROM service_login_state").one())
    old.dispose()
    assert columns.count("notice_key") == 1 and row == (4, None)


# ───────────────────────────── sign-in ─────────────────────────────

def test_sign_in_with_the_login_through_the_ordinary_form(client, configured, make_user):
    r = sign_in(client)
    assert r.status_code == 200, r.text
    assert r.json()["token_type"] == "bearer" and "refresh_token" in r.cookies
    session = client.get("/api/session", headers={"Authorization": f"Bearer {r.json()['access_token']}"}).json()
    assert session["user_id"] == service_id() and session["account_state"] == "active"
    assert session["password_change_required"] is False and session["bot_link"] is None
    # The password and its hash never reach a response.
    assert PASSWORD not in r.text and HASH not in r.text


@pytest.mark.parametrize("login,password,status", [
    (LOGIN, "Wrong-Password-123", 401), (LOGIN, "", 401), ("Root", PASSWORD, 422), (" root", PASSWORD, 422),
    ("root ", PASSWORD, 422), (service_account.EMAIL, PASSWORD, None),
])
def test_only_the_exact_login_and_password_sign_in(client, configured, login, password, status):
    service_account.sync()
    r = sign_in(client, password=password, login=login)
    assert r.status_code != 200 and (status is None or r.status_code == status), r.text


def test_the_contact_address_is_no_sign_in(client, configured):
    service_account.sync()
    # Its address is reserved and never an e-mail route: no account answers to it.
    assert db.get_user_by_email(service_account.EMAIL).is_service
    with db._session() as s:
        s.query(ContactInfoORM).filter_by(user_id=service_id()).update({"email": "service@test.ru"})
        s.commit()
    assert sign_in(client, login="service@test.ru").status_code == 401


def test_no_password_change_or_vk_on_the_service_account(client, configured, mock_vk):
    _, headers = service(client)
    r = client.post("/api/auth/change-password", headers=headers,
                    json={"old_password": PASSWORD, "new_password": "Another-Service-Pass-2"})
    assert r.status_code == 403
    assert client.post("/api/auth/vk/link", headers=headers, json={"access_token": "t", "id_token": "i"}).status_code == 403
    with db._session() as s:
        assert s.query(UserORM).filter(UserORM.is_service.is_(True)).one().hashed_password == HASH


def test_removed_configuration_stops_sign_in_sessions_and_refresh(client, configured, monkeypatch):
    sid, headers = service(client)
    refresh = client.cookies.get("refresh_token")
    assert client.get("/api/session", headers=headers).status_code == 200
    monkeypatch.setattr(settings, "ROOT_PASSWORD_HASH", "")
    assert client.get("/api/session", headers=headers).status_code == 401
    assert client.post("/api/auth/refresh", json={"refresh_token": refresh}).status_code == 401
    assert sign_in(client).status_code == 422
    service_account.sync()  # the restart without it
    with db._session() as s:
        row = s.get(UserORM, sid)
        assert row.hashed_password == "" and s.query(RefreshTokenORM).filter_by(user_id=sid).count() == 0
    # Configured again: the old session stays ended, a new sign-in works.
    monkeypatch.setattr(settings, "ROOT_PASSWORD_HASH", HASH)
    service_account.sync()
    assert client.get("/api/session", headers=headers).status_code == 401
    assert service(client)[0] == sid


def test_a_new_password_ends_the_old_sessions(client, configured, monkeypatch):
    sid, headers = service(client)
    monkeypatch.setattr(settings, "ROOT_PASSWORD_HASH", auth.hash_password("Rotated-Service-Pass-3"))
    service_account.sync()
    assert client.get("/api/session", headers=headers).status_code == 401
    assert sign_in(client).status_code == 401
    assert sign_in(client, password="Rotated-Service-Pass-3").status_code == 200


def test_failed_sign_ins_are_limited_per_client(client, app, configured, make_user):
    service_account.sync()
    site = from_peer(app, "172.19.0.3")  # behind nginx, as in production

    def attempt(address, password="Wrong-Password-123"):
        return site.post("/api/auth/login", json={"email": LOGIN, "password": password},
                         headers={"X-Forwarded-For": address, "User-Agent": AGENT})

    statuses = [attempt("203.0.113.7").status_code for _ in range(service_account.THROTTLE_LIMIT)]
    assert statuses == [401] * service_account.THROTTLE_LIMIT
    limited = attempt("203.0.113.7", PASSWORD)  # even the right password waits
    assert limited.status_code == 429 and limited.headers["Retry-After"] == str(service_account.THROTTLE_WINDOW_S)
    assert attempt("198.51.100.4", PASSWORD).status_code == 200
    # A success gives its attempt back: only failures count.
    with db._session() as s:
        assert s.get(ServiceLoginThrottleORM, service_account._throttle_key("198.51.100.4")).count == 0
    # An ordinary account's sign-in is not counted or held by it.
    person = make_user()
    assert site.post("/api/auth/login", json={"email": person.email, "password": person.password},
                     headers={"X-Forwarded-For": "203.0.113.7"}).status_code == 200
    # The window passes.
    later = datetime.now(timezone.utc) + timedelta(seconds=service_account.THROTTLE_WINDOW_S)
    assert service_account.reserve("203.0.113.7") is None and service_account.reserve("203.0.113.7", later) is not None


def test_parallel_attempts_of_one_client_stay_within_the_limit(client, app, configured):
    """An attempt is taken before the password is checked: a burst gets no more than the limit."""
    import asyncio
    import httpx
    service_account.sync()
    burst = 3 * service_account.THROTTLE_LIMIT

    async def attempts():
        transport = httpx.ASGITransport(app=app, client=("203.0.113.8", 40000))
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            return await asyncio.gather(*(c.post("/api/auth/login", json={"email": LOGIN, "password": "Wrong-Password-123"})
                                          for _ in range(burst)))

    statuses = sorted(r.status_code for r in asyncio.run(attempts()))
    assert statuses == [401] * service_account.THROTTLE_LIMIT + [429] * (burst - service_account.THROTTLE_LIMIT)


# ───────────────────────────── notifications ─────────────────────────────

@pytest.fixture
def watchers(make_user, make_block):
    """The chair, the master of the block named exactly IT and a bystander."""
    chair = make_user(super_user=True, name="Председатель", surname="Тестовый")
    master = make_user(name="Мастер", surname="Айтишный")
    make_block(name="IT")
    db.set_block_leader("IT", master.user_id)
    other_master = make_user(name="Мастер", surname="Другой")
    make_block(name="IT-отдел")
    db.set_block_leader("IT-отдел", other_master.user_id)
    return chair, master, other_master


def test_a_sign_in_notifies_the_chair_and_the_it_master_on_the_site_only(client, app, configured, watchers):
    chair, master, other = watchers
    with db._session() as s:  # VK delivery on for both, linked VK: still no VK row
        for uid in (chair.user_id, master.user_id):
            s.get(UserORM, uid).bot_link_state = "ok"
        s.commit()
    site = from_peer(app, "172.19.0.3")
    r = site.post("/api/auth/login", json={"email": LOGIN, "password": PASSWORD},
                  headers={"X-Forwarded-For": "203.0.113.7", "User-Agent": AGENT})
    assert r.status_code == 200, r.text
    for person in (chair, master):
        [(kind, payload)] = notices(person.user_id)
        assert kind == "service_login" and payload["ip"] == "203.0.113.7" and payload["browser"] == "Chrome 130, macOS"
        item = client.get("/api/notifications", headers=person.headers).json()["items"][0]
        assert re.fullmatch(r"Вход в сервисный аккаунт: \d\d\.\d\d\.\d{4} \d\d:\d\d МСК, IP 203\.0\.113\.7, Chrome 130, macOS",
                            item["text"]), item["text"]
        assert item["target"] is None
    assert notices(other.user_id) == [] and notices(service_id()) == []
    with db._session() as s:
        assert s.query(NotificationDeliveryEventORM).count() == 0


def test_without_an_it_block_only_the_chair_hears(client, configured, make_user, make_block):
    chair = make_user(super_user=True)
    lookalike = make_user()
    make_block(name="it")
    db.set_block_leader("it", lookalike.user_id)
    service(client)
    assert [k for k, _ in notices(chair.user_id)] == ["service_login"]
    assert notices(lookalike.user_id) == []


def test_three_failures_in_a_row_notify_once_per_streak_and_a_success_resets_it(client, configured, watchers):
    chair, master, _ = watchers
    wrong = lambda agent=AGENT: sign_in(client, password="Wrong-Password-123", agent=agent)  # noqa: E731
    assert [wrong().status_code for _ in range(2)] == [401, 401]
    assert notices(chair.user_id, "service_login_failed") == []
    assert sign_in(client).status_code == 200  # resets the count
    assert [wrong().status_code for _ in range(2)] == [401, 401]
    assert notices(chair.user_id, "service_login_failed") == []
    assert wrong().status_code == 401
    for person in (chair, master):
        [(_, payload)] = notices(person.user_id, "service_login_failed")
        assert payload["failures"] == 3 and payload["ip"] == "testclient" and payload["browser"] == "Chrome 130, macOS"
        texts = [i["text"] for i in client.get("/api/notifications", headers=person.headers).json()["items"]]
        assert any(t.startswith("Неудачные попытки входа в сервисный аккаунт (3 подряд): ") for t in texts), texts
    with db._session() as s:
        assert s.get(ServiceLoginStateORM, 1).failures == 3
        assert s.query(NotificationDeliveryEventORM).count() == 0
    # The streak goes on: its one notice tells the count and the last attempt, unread again.
    assert client.post("/api/notifications/read-all", headers=chair.headers).status_code == 200
    firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"
    for _ in range(2):  # 7 failures from this client so far, 3 more to come: within its limit
        wrong(firefox)
    for person in (chair, master):
        [(_, payload)] = notices(person.user_id, "service_login_failed")
        assert payload["failures"] == 5 and payload["browser"] == "Firefox 131, Windows"
        assert client.get("/api/notifications/unread-count", headers=person.headers).json()["count"] >= 1
    [unread] = client.get("/api/notifications?unread=true", headers=chair.headers).json()["items"]
    assert unread["text"].startswith("Неудачные попытки входа в сервисный аккаунт (5 подряд): "), unread["text"]
    # A success ends the streak; the next one has its own notice.
    assert sign_in(client).status_code == 200
    assert [wrong().status_code for _ in range(3)] == [401] * 3
    assert [p["failures"] for _, p in notices(chair.user_id, "service_login_failed")] == [5, 3]
    with db._session() as s:
        assert s.query(NotificationDeliveryEventORM).count() == 0


@pytest.mark.parametrize("agent,summary", [
    (AGENT, "Chrome 130, macOS"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox 131, Windows"),
    ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) "
     "Version/17.5 Mobile/15E148 Safari/604.1", "Safari 17, iOS"),
    ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 "
     "YaBrowser/24.10.0.0 Safari/537.36", "Яндекс Браузер 24, Windows"),
    ("curl/8.7.1", "curl/8.7.1"), ("", "неизвестный браузер"), ("<script>", "script"),
    pytest.param("Chrome/" + "9" * 8000, "Chrome 9999", id="a long version"),
    pytest.param("x" * 8000, "x" * 40, id="a long unknown agent"),
])
def test_the_browser_is_a_short_summary(agent, summary):
    assert service_account.browser(agent) == summary
    assert len(service_account.browser(agent)) <= service_account.BROWSER_MAX


# ───────────────────────────── rights ─────────────────────────────

def test_the_service_account_has_every_capability_of_the_chair_and_more(client, configured, make_user):
    chair = make_user(super_user=True)
    _, headers = service(client)
    mine = set(client.get("/api/session", headers=headers).json()["capabilities"])
    chairs = set(client.get("/api/session", headers=chair.headers).json()["capabilities"])
    assert chairs <= mine
    import access
    assert service_account.is_service_id(service_id())
    # Every relation any rule names, whatever the object; a rule's state still narrows it.
    assert access.relations(service_id()) == access.relations(service_id(), "block", "IT") == access.SERVICE_RELATIONS
    for action, rule in access.POLICY.items():
        for state, holders in (rule.items() if isinstance(rule, access.ByState) else [(None, rule)]):
            assert access.allowed(service_id(), action, state=state) == bool(holders), (action, state)


def test_chair_only_actions(client, configured, make_user):
    """Opening and closing a season and leadership changes are the chair's alone (АВ-49)."""
    chair = make_user(super_user=True)
    deputy = make_user()
    _, headers = service(client)
    s = client.post("/api/seasons", headers=headers, json=dict(title="Сезон сервиса", type="autumn_winter",
                                                                starts_at=stamp(-1), ends_at=stamp(60)))
    assert s.status_code in (200, 201), s.text
    opened = client.post(f"/api/seasons/{s.json()['season_id']}/open", headers=headers,
                         json={"expected_revision": s.json()["revision"]})
    assert opened.status_code == 200, opened.text
    lead = client.get("/api/leadership", headers=headers).json()
    r = client.put("/api/leadership/deputies", headers=headers,
                   json={"user_ids": [deputy.user_id], "expected_revision": lead["revision"]})
    assert r.status_code == 200, r.text
    # The legacy chair and «тачки» dependencies too.
    assert client.get("/api/accounts/archive", headers=headers).status_code == 200
    assert client.get("/api/pgas-admins", headers=headers).status_code == 200
    assert chair.user_id != service_id()


def test_the_session_names_the_service_account(client, configured, make_user):
    """The client leaves it out of every people choice and explains its refusals by this flag."""
    person = make_user(super_user=True)
    _, headers = service(client)
    assert client.get("/api/session", headers=headers).json()["service_account"] is True
    assert client.get("/api/session", headers=person.headers).json()["service_account"] is False


def test_its_own_profile_opens_with_its_reserved_address(client, configured):
    """«Мой профиль» and the task form read GET /profile/me: the reserved .invalid address
    is no mailbox, yet it is the account's own contact row."""
    sid, headers = service(client)
    r = client.get("/api/profile/me", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["user_id"] == sid and r.json()["name"] == NAME and r.json()["email"] == service_account.EMAIL
    # Nobody else's contact gets past the address check that way.
    from main import MeOut
    with pytest.raises(ValidationError):
        MeOut.model_validate({**r.json(), "email": "someone@system.invalid"})


def test_its_own_profile_saves_back_its_reserved_address_which_stays_its_alone(client, configured, make_user):
    """The editor sends back the address it read: the service account saves with its reserved
    one unchanged, but takes no real address, and nobody else takes the reserved one."""
    sid, headers = service(client)

    def save(who, profile):
        editor = client.get("/api/profile/me/editor", headers=who).json()
        return client.patch("/api/profile/me/editor", headers=who, json=dict(
            expected_revision=editor["revision"], expected_fingerprint=editor["fingerprint"], profile=profile))

    editor = client.get("/api/profile/me/editor", headers=headers).json()
    assert editor["contact"]["email"] == service_account.EMAIL
    r = save(headers, {"email": service_account.EMAIL, "location": "Сервер"})
    assert r.status_code == 200, r.text
    assert r.json()["contact"]["email"] == service_account.EMAIL and r.json()["contact"]["location"] == "Сервер"
    assert client.patch(f"/api/profile/{sid}", headers=headers, json={"email": service_account.EMAIL}).status_code == 200
    # A real address would be squatted by an account nobody sees.
    r = save(headers, {"email": "taken-by-root@example.com"})
    assert r.status_code == 422 and r.json()["detail"]["fields"]["errors"][0]["loc"] == ["email"], r.text
    assert client.patch(f"/api/profile/{sid}", headers=headers, json={"email": "taken-by-root@example.com"}).status_code == 422
    person = make_user()
    r = save(person.headers, {"email": service_account.EMAIL})
    assert r.status_code == 422 and r.json()["detail"]["fields"]["errors"][0]["loc"] == ["email"], r.text
    assert client.patch(f"/api/profile/{person.user_id}", headers=person.headers,
                        json={"email": service_account.EMAIL}).status_code == 422
    assert db.get_contact(sid).email == service_account.EMAIL
    assert db.get_contact(person.user_id).email != service_account.EMAIL


def test_nobody_takes_the_reserved_address_before_the_service_account_exists(client, make_user):
    """With the account never configured no row holds the address: the startup step would
    later stop on the unique contact address."""
    person = make_user()
    r = client.patch(f"/api/profile/{person.user_id}", headers=person.headers, json={"email": service_account.EMAIL})
    assert r.status_code == 422, r.text
    assert db.get_contact(person.user_id).email != service_account.EMAIL


def test_the_bot_console_is_open(client, configured, make_user):
    _, headers = service(client)
    assert client.get("/api/bot/console/status", headers=headers).status_code == 200
    assert client.get("/api/bot/maintainers", headers=headers).status_code == 200


def test_the_bot_console_refuses_its_update_requests_with_its_own_code(client, configured, monkeypatch):
    """The update server needs the requester's VK and the service account has none (an open
    owner question, 2026-11-08): its own refusal instead of a request to link a VK it cannot link."""
    from bot_models import BotCommandORM
    from test_bot_api import HASH as BOT_HASH
    from test_bot_console import URL, beat
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", BOT_HASH)
    monkeypatch.setattr(settings, "PUBLIC_SITE_URL", "https://profkom.example")
    beat(client)
    _, headers = service(client)
    for kind, args in (("updates_check", {}), ("update", {"version": "2.5.0"}), ("rollback", {"version": "2.3.0"})):
        r = client.post(f"{URL}/commands", headers=headers, json={"kind": kind, "args": args})
        assert (r.status_code, r.json()["detail"]["code"]) == (409, "bot_console_service_vk"), (kind, r.text)
    with db._session() as s:
        assert s.query(BotCommandORM).count() == 0
    # The log and a restart need no VK.
    assert client.post(f"{URL}/commands", headers=headers, json={"kind": "logs"}).status_code == 200


def test_no_deadline_banner_or_gate(client, configured, make_user, monkeypatch):
    from test_bot_api import HASH as BOT_HASH
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", BOT_HASH)
    monkeypatch.setattr(settings, "BOT_LINK_DEADLINE", datetime.now(timezone.utc) - timedelta(days=1))
    person = make_user()
    assert client.get("/api/blocks", headers=person.headers).status_code == 403
    _, headers = service(client)
    assert client.get("/api/blocks", headers=headers).status_code == 200
    assert client.get("/api/session", headers=headers).json()["bot_link"] is None
    me = client.get("/api/bot-link/me", headers=headers).json()
    assert me["enabled"] is False and not me.get("required") and not me.get("blocked")
    assert client.post("/api/bot-link/code", headers=headers).status_code == 404


# ───────────────────────────── shown nowhere ─────────────────────────────

@pytest.fixture
def org(client, configured, make_user, make_block):
    """A small organisation where the service account has acted: a task, a comment, a merit."""
    chair = make_user(super_user=True, name="Председатель", surname="Тестовый", pgas_admin=True)
    master = make_user(name="Мастер", surname="Айтишный")
    member = make_user(name="Участник", surname="Обычный")
    make_block(name="IT", arr_of_human=[member.user_id])
    db.set_block_leader("IT", master.user_id)
    sid, headers = service(client)
    block = next(b for b in client.get("/api/blocks", headers=headers).json() if b["name"] == "IT")
    season = client.post("/api/seasons", headers=headers, json=dict(
        title="Сезон", type="autumn_winter", starts_at=stamp(-5), ends_at=stamp(60))).json()
    season = client.post(f"/api/seasons/{season['season_id']}/open", headers=headers,
                         json={"expected_revision": season["revision"]}).json()
    task = client.post("/api/tasks", headers=headers, json=dict(
        season_id=season["season_id"], scope={"kind": "block", "id": block["block_id"]}, title="Задача сервиса",
        description=rich("Описание"), deadline_at=stamp(5), criteria={}, assignees=[{"user_id": member.user_id, "hours": 1}]))
    assert task.status_code in (200, 201), task.text
    comment = client.post(f"/api/tasks/{task.json()['task_id']}/comments", headers=headers,
                          json={"content": rich("Комментарий сервиса")})
    assert comment.status_code in (200, 201), comment.text
    return dict(chair=chair, master=master, member=member, sid=sid, headers=headers, block=block,
                season=season, task=task.json())


def mentions(data, sid):
    """Where `data` names the service account: its id as a person, its name or its address."""
    found = []

    def walk(node, path):
        if isinstance(node, dict):
            for key, value in node.items():
                if key.endswith("user_id") and value == sid:
                    found.append(path + key)
                walk(value, path + key + ".")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                if value == sid and path.rstrip(".").endswith(("user_ids", "members", "arr_of_human")):
                    found.append(f"{path}{index}")
                walk(value, f"{path}{index}.")
        elif isinstance(node, str) and (NAME in node or service_account.EMAIL in node):
            found.append(path.rstrip("."))
    walk(data, "")
    return found


PEOPLE = [
    "/api/contacts", "/api/contacts?q=Сервис", "/api/contacts?user_id={sid}", "/api/contacts/emails",
    "/api/contacts/archive", "/api/participants/categories?user_ids={sid},{member}", "/api/pgas-admins", "/api/registrations",
    "/api/accounts/archive", "/api/broadcasts/senders", "/api/bot/maintainers", "/api/blocks", "/api/blocks/{block}",
    "/api/leadership", "/api/task-queues", "/api/tasks/{task}/mention-candidates", "/api/seasons/{season}/summary",
    "/api/seasons/{season}/analytics", "/api/seasons/{season}/statistics", "/api/seasons/{season}/master-bonuses",
    "/api/seasons/{season}/kkr-control", "/api/assessments?season_id={season}", "/api/merits?season_id={season}",
    "/api/workspace/home", "/api/dashboard",
]


@pytest.mark.parametrize("path", PEOPLE)
def test_no_list_of_people_shows_it(client, org, path):
    url = path.format(sid=org["sid"], member=org["member"].user_id, block=org["block"]["block_id"],
                      task=org["task"]["task_id"], season=org["season"]["season_id"])
    # As the service account itself (every right) and as the chair, where the chair reads it.
    for chair, who in ((False, org["headers"]), (True, org["chair"].headers)):
        r = client.get(url, headers=who)
        if chair and r.status_code == 403:
            continue  # the bot console's lists: the IT master and maintainers only
        assert r.status_code == 200, (url, r.status_code, r.text[:300])
        assert mentions(r.json(), org["sid"]) == [], (url, mentions(r.json(), org["sid"]))


def test_the_audience_count_leaves_it_out(client, org, monkeypatch):
    from test_bot_api import HASH as BOT_HASH
    monkeypatch.setattr(settings, "BOT_API_TOKEN_SHA256", BOT_HASH)
    audience = client.get("/api/broadcasts/audience", headers=org["chair"].headers).json()
    with db._session() as s:
        people = s.query(UserORM).filter_by(account_state="active", banned=False).count()
    assert audience["total"] == people - 1


def test_the_summary_workbook_leaves_it_out(client, org):
    import zipfile
    r = client.get(f"/api/seasons/{org['season']['season_id']}/summary.xlsx", headers=org["chair"].headers)
    assert r.status_code == 200, r.text[:200]
    with zipfile.ZipFile(io.BytesIO(r.content)) as book:
        text = "".join(book.read(name).decode("utf-8") for name in book.namelist() if name.endswith(".xml"))
    assert "Участник Обычный" in text or "Обычный" in text
    assert NAME not in text and service_account.EMAIL not in text


@pytest.mark.parametrize("path", ["/api/profile/{sid}", "/api/participants/{sid}/category",
                                  "/api/participants/{sid}/participation"])
def test_its_own_cards_answer_as_missing(client, org, path):
    assert client.get(path.format(sid=org["sid"]), headers=org["chair"].headers).status_code == 404


def test_everyone_notices_leave_it_out(client, org):
    with db._session() as s:
        from notifications import emit_everyone, recipients_among
        assert recipients_among(s, [org["sid"], org["member"].user_id], lambda uid: True) == [org["member"].user_id]
        assert org["sid"] not in recipients_among(s, None, lambda uid: True)
        emit_everyone(s, "broadcast", {"title": "Всем"}, f"all:{uuid.uuid4()}")
        s.commit()
    assert notices(org["sid"], "broadcast") == [] and notices(org["member"].user_id, "broadcast")


def test_it_is_shown_by_name_without_a_profile_link(client, org):
    task = client.get(f"/api/tasks/{org['task']['task_id']}", headers=org["chair"].headers).json()
    assert task["created_by"] == {"user_id": None, "display_name": NAME, "avatar_url": None}
    comments = client.get(f"/api/tasks/{org['task']['task_id']}/comments", headers=org["chair"].headers).json()
    items = comments["items"] if isinstance(comments, dict) else comments
    assert items[0]["author"] == {"user_id": None, "display_name": NAME, "avatar_url": None}


# ───────────────────────────── refused as a person ─────────────────────────────

def test_it_cannot_be_chosen_for_anything(client, org):
    chair, sid = org["chair"].headers, org["sid"]
    season, block, task = org["season"]["season_id"], org["block"], org["task"]

    def refused(r):
        assert r.status_code in (404, 422), (r.status_code, r.text[:300])
        return r

    refused(client.post("/api/tasks", headers=chair, json=dict(
        season_id=season, scope={"kind": "block", "id": block["block_id"]}, title="Нельзя", description=rich(""),
        deadline_at=stamp(5), criteria={}, assignees=[{"user_id": sid, "hours": 1}])))
    lead = client.get("/api/leadership", headers=chair).json()
    refused(client.put("/api/leadership/deputies", headers=chair, json={"user_ids": [sid], "expected_revision": lead["revision"]}))
    current = client.get(f"/api/blocks/{block['block_id']}", headers=chair).json()
    refused(client.put(f"/api/blocks/{block['block_id']}/leader", headers=chair,
                       json={"user_id": sid, "expected_revision": current["revision"]}))
    refused(client.post("/api/merits", headers=chair, json=dict(
        season_id=season, description="", assigned_at=stamp(-3), deadline_at=stamp(-2), criteria={}, reason="Тест",
        source_kind="block_volunteer", scope={"kind": "block", "id": block["block_id"]}, title="Нельзя",
        recipients=[{"user_id": sid, "hours": 1, "evaluation": 1, "completed_at": stamp(-2)}])))
    refused(client.put(f"/api/bot/maintainers/{sid}", headers=chair, json={"granted": True}))
    refused(client.put(f"/api/broadcasts/senders/{sid}", headers=chair, json={"granted": True}))
    fresh = client.get(f"/api/tasks/{task['task_id']}", headers=chair).json()
    refused(client.post(f"/api/tasks/{task['task_id']}/roster", headers=chair,
                        json={"command": "assign", "user_id": sid, "expected_revision": fresh["revision"]}))
    with db._session() as s:
        from database import AssignmentORM, RoleAssignmentORM
        assert s.query(AssignmentORM).filter_by(assignee_user_id=sid).count() == 0
        assert s.query(RoleAssignmentORM).filter_by(user_id=sid).count() == 0
        assert s.get(BlockORM, "IT").master_user_id != sid


# ───────────────────────────── what it leaves behind ─────────────────────────────

def test_a_queue_it_creates_belongs_to_a_person(client, org):
    from database import TaskQueueORM
    headers, master, chair, sid = org["headers"], org["master"], org["chair"], org["sid"]
    block = {"kind": "block", "id": org["block"]["block_id"]}
    r = client.post("/api/task-queues", headers=headers, json=dict(name="Отладка", key="DBG", scope=block, is_private=True))
    assert r.status_code == 200, r.text
    queue = r.json()
    # The recovery chain's next owner: the block's master manages it and hears of requests.
    assert queue["owner"]["user_id"] == master.user_id and queue["owner_unavailable"] is False
    assert "manage_queue" in queue["capabilities"]  # the service account still holds every right
    mine = client.get(f"/api/task-queues/{queue['queue_id']}", headers=master.headers).json()
    assert "manage_queue" in mine["capabilities"]
    asked = client.post(f"/api/task-queues/{queue['queue_id']}/access-requests", headers=org["member"].headers,
                        json={"message": "Нужен доступ"})
    assert asked.status_code == 200, asked.text
    assert [k for k, _ in notices(master.user_id, "task_queue_access_request")] == ["task_queue_access_request"]
    assert notices(sid, "task_queue_access_request") == []
    # A named owner instead, never itself.
    named = client.post("/api/task-queues", headers=headers, json=dict(
        name="Отладка председателя", key="DBGC", scope={"kind": "chair", "id": "chair"}, owner_user_id=chair.user_id))
    assert named.status_code == 200 and named.json()["owner"]["user_id"] == chair.user_id, named.text
    itself = client.post("/api/task-queues", headers=headers, json=dict(name="Нельзя", key="DBGS", scope=block, owner_user_id=sid))
    assert itself.status_code == 422 and itself.json()["detail"]["code"] == "unknown_user", itself.text
    # A queue it held before (a row of an earlier version) is recovered at the startup pass.
    import queue_ownership
    from sqlalchemy import text
    with database.engine.begin() as c:
        c.execute(text("UPDATE task_queues SET owner_user_id = :sid WHERE queue_id = :q"), dict(sid=sid, q=queue["queue_id"]))
    assert client.get(f"/api/task-queues/{queue['queue_id']}", headers=chair.headers).json()["owner_unavailable"] is True
    assert queue_ownership.reconcile_existing() == 1
    with db._session() as s:
        assert s.get(TaskQueueORM, queue["queue_id"]).owner_user_id == master.user_id


def test_with_no_one_to_own_it_a_queue_needs_a_named_owner(client, configured):
    _, headers = service(client)
    r = client.post("/api/task-queues", headers=headers, json=dict(name="Отладка", key="DBG", scope={"kind": "chair", "id": "chair"}))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "queue_owner_required", r.text


def test_a_person_finishes_the_task_it_opened(client, org):
    from database import TaskORM
    from tracker_collaboration import _managers
    tid, master, member = org["task"]["task_id"], org["master"], org["member"]
    with db._session() as s:
        assert _managers(s, s.get(TaskORM, tid)) == {master.user_id}  # it is told of no access request
    current = client.get(f"/api/tasks/{tid}", headers=member.headers).json()
    assert client.post(f"/api/tasks/{tid}/status", headers=member.headers,
                       json={"expected_revision": current["revision"], "status": "closed"}).status_code == 403
    # The author is never available: its queue's owner closes and reopens the task.
    current = client.get(f"/api/tasks/{tid}", headers=master.headers).json()
    assert "closed" in current["allowed_statuses"], current["allowed_statuses"]
    closed = client.post(f"/api/tasks/{tid}/status", headers=master.headers,
                         json={"expected_revision": current["revision"], "status": "closed"})
    assert closed.status_code == 200, closed.text
    reopened = client.post(f"/api/tasks/{tid}/status", headers=master.headers,
                           json={"expected_revision": closed.json()["revision"], "status": "open"})
    assert reopened.status_code == 200, reopened.text


def test_its_row_leaves_an_install_empty_for_the_first_chair(client, configured):
    from database import LeadershipORM
    from scripts.preset_db import set_admin
    service_account.sync()
    out = io.StringIO()
    with redirect_stdout(out):
        set_admin(custom_payload=dict(name="Председатель", surname="Первый", email="first@test.ru",
                                      password="Synthetic-Chair-Pass-1", group_number="101", tg=""))
    assert "Created the explicitly configured initial chair." in out.getvalue(), out.getvalue()
    with db._session() as s:
        chair = s.get(LeadershipORM, 1).chair_user_id
    assert chair and chair != service_id()


def test_the_hash_helper_reads_without_echo_and_prints_only_the_hash(monkeypatch):
    import importlib.util
    from pathlib import Path
    path = Path(__file__).resolve().parents[1] / "scripts" / "service_password_hash.py"
    spec = importlib.util.spec_from_file_location("service_password_hash", path)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    monkeypatch.setenv("DATABASE_PATH", database.settings.DATABASE_PATH)  # restored after the helper's own
    prompts = []
    monkeypatch.setattr(helper.getpass, "getpass", lambda prompt: prompts.append(prompt) or PASSWORD)
    out = io.StringIO()
    with redirect_stdout(out):
        helper.main()
    printed = out.getvalue().strip()
    assert len(prompts) == 2 and PASSWORD not in out.getvalue()
    assert re.fullmatch(r"\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}", printed) and auth.verify_password(PASSWORD, printed)
    assert Settings(ROOT_LOGIN=LOGIN, ROOT_PASSWORD_HASH=printed).ROOT_PASSWORD_HASH == printed
    monkeypatch.setattr(helper.getpass, "getpass", lambda prompt: "short")
    with pytest.raises(SystemExit):
        helper.main()
