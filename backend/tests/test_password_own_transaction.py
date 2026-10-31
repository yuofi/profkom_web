"""PB-15: register, change-password and temporary-password hash outside the write lock.

bcrypt runs with no unit of work open; the short transaction afterwards repeats the
checks the request made before it, so a change in between gives the answer the
serialized order gives (duplicate e-mail, revoked session, changed password,
lost rights or a protected target).
"""
import pytest

import auth
import main
import database
from database import db, UserORM
from test_admin_cabinet import deputy  # noqa: F401
from test_auth_register import REGISTER_URL, body


def message(response):
    detail = response.json()["detail"]
    return detail["message"] if isinstance(detail, dict) else detail


@pytest.fixture
def hashes(monkeypatch):
    """Record whether each hash ran outside a unit of work; run `between` after it."""
    state = {"outside": [], "between": None}
    original = auth.pwd_ctx.hash

    def hashed(secret, *args, **kwargs):
        state["outside"].append(database._active_session.get() is None)
        value = original(secret, *args, **kwargs)
        if state["between"] is not None:
            between, state["between"] = state["between"], None
            between()
        return value
    monkeypatch.setattr(auth.pwd_ctx, "hash", hashed)
    return state


def test_hashes_run_outside_any_unit_of_work(client, superuser, make_user, hashes):
    user, target = make_user(), make_user()
    hashes["outside"].clear()
    assert client.post(REGISTER_URL, json=body(email="own-tx@test.ru")).status_code == 201
    changed = client.post("/api/auth/change-password", headers=user.headers,
                          json={"old_password": user.password, "new_password": "Own-New-Pass-2026"})
    assert changed.status_code == 200, changed.text
    issued = client.post(f"/api/accounts/{target.user_id}/temporary-password", headers=superuser.headers, json={})
    assert issued.status_code == 200, issued.text
    assert hashes["outside"] == [True, True, True]
    assert all(auth.own_transaction(path) for path in (REGISTER_URL, "/api/auth/change-password",
                                                       f"/api/accounts/{target.user_id}/temporary-password"))
    assert not auth.own_transaction(f"/api/accounts/{target.user_id}/archive")


def test_register_rechecks_the_email_in_its_transaction(client, make_user, hashes):
    hashes["between"] = lambda: make_user(email="Race@Test.ru")
    response = client.post(REGISTER_URL, json=body(email="race@test.ru"))
    assert response.status_code == 409 and message(response) == "Email already registered"
    with db._session() as s:
        assert s.query(UserORM).count() == 1


def test_change_password_rechecks_session_and_concurrent_password(client, make_user, hashes):
    user = make_user()
    hashes["between"] = lambda: db.revoke_sessions(user.user_id)
    revoked = client.post("/api/auth/change-password", headers=user.headers,
                          json={"old_password": user.password, "new_password": "Own-New-Pass-2026"})
    assert (revoked.status_code, message(revoked)) == (401, "Session revoked")
    assert client.post("/api/auth/login", json={"email": user.email, "password": user.password}).status_code == 200

    other = make_user()
    hashes["between"] = lambda: db.update_user(other.user_id, hashed_password=auth.hash_password("Someone-Else-1"))
    raced = client.post("/api/auth/change-password", headers=other.headers,
                        json={"old_password": other.password, "new_password": "Own-New-Pass-2026"})
    assert (raced.status_code, message(raced)) == (400, "Invalid old password")
    assert client.post("/api/auth/login", json={"email": other.email, "password": "Someone-Else-1"}).status_code == 200


def test_temporary_password_rechecks_actor_and_target(client, superuser, deputy, make_user, hashes):
    target = make_user()
    path = f"/api/accounts/{target.user_id}/temporary-password"

    hashes["between"] = lambda: db.revoke_sessions(deputy.user_id)
    revoked = client.post(path, headers=deputy.headers, json={})
    assert (revoked.status_code, message(revoked)) == (401, "Session revoked")

    def ban():
        with db._session() as s:
            s.get(UserORM, superuser.user_id).banned = True
            s.commit()
    hashes["between"] = ban
    banned = client.post(path, headers=superuser.headers, json={})
    assert (banned.status_code, message(banned)) == (403, "User is banned")
    with db._session() as s:
        s.get(UserORM, superuser.user_id).banned = False
        s.commit()

    def archive():
        with db._session() as s:
            s.get(UserORM, target.user_id).account_state = "archived"
            s.commit()
    hashes["between"] = archive
    gone = client.post(path, headers=superuser.headers, json={})
    assert gone.status_code == 404
    with db._session() as s:
        row = s.get(UserORM, target.user_id)
        assert not row.must_change_password and auth.verify_password(target.password, row.hashed_password)
