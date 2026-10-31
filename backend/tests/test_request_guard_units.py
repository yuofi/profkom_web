"""PB-19/PB-30/PB-26: the session guard off the event loop, an early token refusal
with the guard's own answers, and the write-lock wait/hold log."""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from jose import jwt
from sqlalchemy import event

import auth
import database
from auth import precheck_access_token
from database import engine


def _token(**claims):
    payload = {"sub": "1", "type": "access", "exp": datetime.now(timezone.utc) + timedelta(minutes=5), **claims}
    return jwt.encode(payload, auth.SECRET_KEY, algorithm=auth.ALGORITHM)


def _cases(actor):
    expired = _token(sub=str(actor.user_id), exp=datetime.now(timezone.utc) - timedelta(minutes=1))
    tokens = {
        "none": None, "garbage": "not-a-jwt", "expired": expired, "refresh": actor.refresh_token,
        "no-sub": _token(sub=None), "bad-sub": _token(sub="abc"), "stale-version": _token(sub=str(actor.user_id), sv=99),
        "unknown-user": _token(sub="987654"), "valid": actor.access_token,
    }
    requests = [("GET", "/api/tasks"), ("POST", "/api/tasks"), ("GET", "/api/session"), ("GET", "/api/registrations/me"),
                ("POST", "/api/auth/refresh"), ("POST", "/api/feedback"), ("PATCH", "/api/profile/me"),
                ("DELETE", "/api/tasks/missing")]
    for name, token in tokens.items():
        for method, path in requests:
            yield name, method, path, ({"Authorization": f"Bearer {token}"} if token else {})


def _answer(client, method, path, headers):
    response = client.request(method, path, headers=headers, json={})
    return response.status_code, response.text, response.headers.get("www-authenticate")


def test_early_token_refusal_gives_the_guards_own_answers(client, app, make_user):
    actor = make_user()
    with_precheck = {case[:3]: _answer(client, *case[1:]) for case in _cases(actor)}
    app.dependency_overrides[precheck_access_token] = lambda: None
    try:
        without = {case[:3]: _answer(client, *case[1:]) for case in _cases(actor)}
    finally:
        app.dependency_overrides.pop(precheck_access_token, None)
    assert with_precheck == without
    assert with_precheck[("none", "POST", "/api/tasks")][0] == 401
    assert with_precheck[("garbage", "POST", "/api/tasks")][2] == "Bearer"


def test_refused_token_opens_no_unit_of_work(client, make_user):
    statements = []

    def count(_conn, _cursor, statement, *_args):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", count)
    try:
        for headers in ({}, {"Authorization": "Bearer not-a-jwt"}):
            assert client.post("/api/tasks", headers=headers, json={}).status_code == 401
            assert client.get("/api/tasks", headers=headers).status_code == 401
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert statements == []


def test_guard_reads_the_account_in_a_worker_thread(client, make_user, monkeypatch):
    actor = make_user()
    original = auth.get_current_user
    seen = []

    def recorded(token):
        try:
            asyncio.get_running_loop()
            seen.append("event loop")
        except RuntimeError:
            seen.append("worker thread")
        return original(token)
    monkeypatch.setattr(auth, "get_current_user", recorded)
    assert client.get("/api/session", headers=actor.headers).status_code == 200
    assert client.get("/api/tasks", headers=actor.headers).status_code == 200
    assert seen == ["worker thread", "worker thread"]
    # The actor is still visible to the endpoint (set in the request's own context).
    import membership
    actors = []
    monkeypatch.setattr(membership, "blocks_for", lambda uid: actors.append(uid) or [])
    assert client.get("/api/blocks", headers=actor.headers).json() == []
    assert actors == [actor.user_id]


def test_slow_write_unit_is_logged_with_wait_and_hold(client, make_user, monkeypatch, caplog):
    actor = make_user()
    monkeypatch.setattr(database, "WRITE_LOCK_LOG_MS", -1)
    with caplog.at_level(logging.WARNING, logger="profkom.write_lock"):
        client.get("/api/tasks", headers=actor.headers)
        client.patch("/api/profile/me", headers=actor.headers, json={})
    records = [r.getMessage() for r in caplog.records if r.name == "profkom.write_lock"]
    assert len(records) == 1 and records[0].startswith("write unit PATCH /api/profile/me waited "), records
    caplog.clear()
    monkeypatch.setattr(database, "WRITE_LOCK_LOG_MS", 200)
    with caplog.at_level(logging.WARNING, logger="profkom.write_lock"):
        client.patch("/api/profile/me", headers=actor.headers, json={})
    assert not [r for r in caplog.records if r.name == "profkom.write_lock"]
